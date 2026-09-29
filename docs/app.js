'use strict';
/* global N3 */
/**
 * Static Ontology Browser (single-file app.js)
 * Requirements:
 * - Only uses IDs: ontologySelect, loadOntology, status, searchBox, entityList, details
 * - Only uses selector: .filters input[type="checkbox"][data-kind]
 * - Fetches ontologies/catalog.json with [{title,file}]
 * - Parses Turtle in-browser with N3.Parser().parse(ttl)
 * - Indexes outgoing/incoming, blank node contents, types/kinds, labels/defs/comments,
 *   subclass/subproperty, domainOf/rangeOf, inverseOf, and renders details + all triples.
 */

//////////////////////
// IRIs
//////////////////////
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const OBO = 'http://purl.obolibrary.org/obo/';

const RDF_TYPE = RDF + 'type';
const RDF_FIRST = RDF + 'first';
const RDF_REST = RDF + 'rest';
const RDF_NIL = RDF + 'nil';

const RDFS_LABEL = RDFS + 'label';
const RDFS_COMMENT = RDFS + 'comment';
const RDFS_SUBCLASS_OF = RDFS + 'subClassOf';
const RDFS_SUBPROPERTY_OF = RDFS + 'subPropertyOf';
const RDFS_DOMAIN = RDFS + 'domain';
const RDFS_RANGE = RDFS + 'range';

const OWL_CLASS = OWL + 'Class';
const OWL_OBJECT_PROPERTY = OWL + 'ObjectProperty';
const OWL_DATATYPE_PROPERTY = OWL + 'DatatypeProperty';
const OWL_ANNOTATION_PROPERTY = OWL + 'AnnotationProperty';
const OWL_NAMED_INDIVIDUAL = OWL + 'NamedIndividual';

const OWL_RESTRICTION = OWL + 'Restriction';
const OWL_ON_PROPERTY = OWL + 'onProperty';
const OWL_SOME_VALUES_FROM = OWL + 'someValuesFrom';
const OWL_ALL_VALUES_FROM = OWL + 'allValuesFrom';
const OWL_HAS_VALUE = OWL + 'hasValue';
const OWL_MIN_CARDINALITY = OWL + 'minCardinality';
const OWL_MAX_CARDINALITY = OWL + 'maxCardinality';
const OWL_CARDINALITY = OWL + 'cardinality';
const OWL_INVERSE_OF = OWL + 'inverseOf';
const OWL_EQUIVALENT_CLASS = OWL + 'equivalentClass';
const OWL_INTERSECTION_OF = OWL + 'intersectionOf';
const OWL_UNION_OF = OWL + 'unionOf';
const OWL_COMPLEMENT_OF = OWL + 'complementOf';

const IAO_DEF = OBO + 'IAO_0000115';
const SKOS_DEF = SKOS + 'definition';

//////////////////////
// State
//////////////////////
const S = {
  prefixes: {},
  // quads
  quads: [],
  // indexes
  out: new Map(),        // iri -> [quad]
  inc: new Map(),        // iri -> [quad] (object is iri)
  bnodes: new Map(),     // bnodeId -> [quad] where subject is bnode
  // annotations
  label: new Map(),      // iri -> string
  defn: new Map(),       // iri -> string
  comment: new Map(),    // iri -> string
  // relations
  parents: new Map(),    // child -> Set(parent)
  children: new Map(),   // parent -> Set(child)
  pParents: new Map(),   // childProp -> Set(parentProp)
  pChildren: new Map(),  // parentProp -> Set(childProp)
  domain: new Map(),     // prop -> Set(domainClass)
  range: new Map(),      // prop -> Set(rangeClass)
  domainOf: new Map(),   // class -> Set(prop)
  rangeOf: new Map(),    // class -> Set(prop)
  inverseOf: new Map(),  // prop -> Set(inverseProp)
  // types/kinds
  types: new Map(),      // iri -> Set(typeIri)
  kind: new Map(),       // iri -> kind string
  // entity list
  entities: [],          // [{iri, kind, label, defKey}]
  // UI
  activeKinds: new Set(['Class','Object property','Data property','Annotation property','Individual']),
  selected: null,
};

//////////////////////
// DOM helpers (no innerHTML with user data)
//////////////////////
const byId = (id) => document.getElementById(id);
function ce(tag, attrs) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (k === 'className') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'type') n.type = v;
      else if (k === 'value') n.value = v;
      else if (k === 'disabled') n.disabled = !!v;
      else if (k === 'href') n.setAttribute('href', v);
      else if (k === 'title') n.setAttribute('title', v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, String(v));
    }
  }
  return n;
}
function clear(node){ if(node) node.innerHTML=''; }
function setStatus(msg, isError){
  const st = byId('status');
  if (!st) return;
  st.textContent = msg || '';
  if (isError) st.style.color = 'crimson';
  else st.style.color = '';
}

//////////////////////
// Term helpers
//////////////////////
function isNamedNode(t){ return t && t.termType === 'NamedNode'; }
function isBlankNode(t){ return t && t.termType === 'BlankNode'; }
function isLiteral(t){ return t && t.termType === 'Literal'; }
function iri(t){ return isNamedNode(t) ? t.value : null; }
function bnodeId(t){ return isBlankNode(t) ? t.value : null; }

function termText(t){
  if (!t) return '';
  if (isNamedNode(t)) return t.value;
  if (isBlankNode(t)) return '_:' + t.value;
  if (isLiteral(t)) {
    const lang = t.language ? '@' + t.language : '';
    const dt = t.datatype && t.datatype.value && t.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string'
      ? '^^' + t.datatype.value
      : '';
    return '"' + t.value + '"' + lang + dt;
  }
  return String(t.value || '');
}

function displayIri(iriStr){
  const lbl = S.label.get(iriStr);
  if (lbl) return lbl;
  // compact fallback: fragment or last path segment
  try {
    const u = new URL(iriStr);
    if (u.hash && u.hash.length > 1) return u.hash.slice(1);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  } catch(_e){}
  return iriStr;
}

function pushArr(map, key, val){
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(val);
}
function pushSet(map, key, val){
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(val);
}

//////////////////////
// Fetch + parse
//////////////////////
async function fetchText(url){
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('Fetch failed: ' + url + ' (' + r.status + ')');
  return await r.text();
}

async function loadCatalog(){
  const select = byId('ontologySelect');
  if (!select) { setStatus('Missing #ontologySelect', true); return; }

  let cat;
  try {
    cat = JSON.parse(await fetchText('ontologies/catalog.json'));
  } catch (e) {
    setStatus('Could not load ontologies/catalog.json: ' + (e && e.message ? e.message : e), true);
    return;
  }
  const items = Array.isArray(cat) ? cat : (Array.isArray(cat.ontologies) ? cat.ontologies : []);
  clear(select);
  for (const it of items) {
    const opt = ce('option', { value: it.file || '', text: it.title || it.file || '(untitled)' });
    select.appendChild(opt);
  }
  if (!items.length) setStatus('Catalog empty: expected array of {title,file}', true);
  else setStatus('Catalog loaded. Choose an ontology and click Load.');
}

async function loadSelectedOntology(){
  const select = byId('ontologySelect');
  if (!select) return;
  const file = select.value;
  if (!file) { setStatus('No ontology selected.', true); return; }
  await loadOntologyTtl(file);
}

function resetState(){
  S.prefixes = {};
  S.quads = [];
  for (const m of [S.out,S.inc,S.bnodes,S.label,S.defn,S.comment,S.parents,S.children,S.pParents,S.pChildren,S.domain,S.range,S.domainOf,S.rangeOf,S.inverseOf,S.types,S.kind]) m.clear();
  S.entities = [];
  S.selected = null;
}

async function loadOntologyTtl(file){
  resetState();
  clear(byId('entityList'));
  clear(byId('details'));
  setStatus('Loading ' + file + ' …');

  if (typeof N3 === 'undefined' || !N3.Parser) {
    setStatus('N3 not found. Ensure N3 browser build is loaded.', true);
    return;
  }

  let ttl;
  try { ttl = await fetchText(file); }
  catch(e){ setStatus('Could not fetch TTL: ' + (e && e.message ? e.message : e), true); return; }

  const parser = new N3.Parser();
  const quads = [];
  const prefixes = {};
  try {
    await new Promise((resolve, reject) => {
      parser.parse(ttl, (err, quad, pref) => {
        if (err) return reject(err);
        if (pref) Object.assign(prefixes, pref);
        if (quad) quads.push(quad);
        else resolve();
      });
    });
  } catch(e) {
    setStatus('Parse error: ' + (e && e.message ? e.message : e), true);
    return;
  }

  S.quads = quads;
  S.prefixes = prefixes;
  buildIndexes();
  buildEntities();
  renderEntityList();
  setStatus('Loaded ' + quads.length.toLocaleString() + ' triples from ' + file);
}

//////////////////////
// Index building
//////////////////////
function buildIndexes(){
  // main pass
  for (const q of S.quads) {
    const sIri = iri(q.subject);
    const pIri = iri(q.predicate);
    const oIri = iri(q.object);

    if (isBlankNode(q.subject)) pushArr(S.bnodes, q.subject.value, q);
    if (sIri) pushArr(S.out, sIri, q);
    if (oIri) pushArr(S.inc, oIri, q);

    // annotations
    if (sIri && pIri === RDFS_LABEL && isLiteral(q.object) && !S.label.has(sIri)) S.label.set(sIri, q.object.value);
    if (sIri && (pIri === IAO_DEF || pIri === SKOS_DEF) && isLiteral(q.object) && !S.defn.has(sIri)) S.defn.set(sIri, q.object.value);
    if (sIri && pIri === RDFS_COMMENT && isLiteral(q.object) && !S.comment.has(sIri)) S.comment.set(sIri, q.object.value);

    // types
    if (sIri && pIri === RDF_TYPE && oIri) {
      if (!S.types.has(sIri)) S.types.set(sIri, new Set());
      S.types.get(sIri).add(oIri);
    }

    // hierarchies
    if (sIri && pIri === RDFS_SUBCLASS_OF && oIri) {
      pushSet(S.parents, sIri, oIri);
      pushSet(S.children, oIri, sIri);
    }
    if (sIri && pIri === RDFS_SUBPROPERTY_OF && oIri) {
      pushSet(S.pParents, sIri, oIri);
      pushSet(S.pChildren, oIri, sIri);
    }

    // domain/range + reverse lookup
    if (sIri && pIri === RDFS_DOMAIN && oIri) {
      pushSet(S.domain, sIri, oIri);
      pushSet(S.domainOf, oIri, sIri);
    }
    if (sIri && pIri === RDFS_RANGE && oIri) {
      pushSet(S.range, sIri, oIri);
      pushSet(S.rangeOf, oIri, sIri);
    }

    // inverseOf
    if (sIri && pIri === OWL_INVERSE_OF && oIri) {
      pushSet(S.inverseOf, sIri, oIri);
      pushSet(S.inverseOf, oIri, sIri);
    }
  }

  // add definitions fallback to comment if missing
  for (const [k,v] of S.comment.entries()) {
    if (!S.defn.has(k)) S.defn.set(k, v);
  }

  // heuristic kinds: subjects of subClassOf => Class if not typed; subjects of domain/range => Property if not typed
  for (const q of S.quads) {
    const sIri = iri(q.subject);
    const pIri = iri(q.predicate);
    if (!sIri || !pIri) continue;

    if (pIri === RDFS_SUBCLASS_OF) {
      if (!S.types.has(sIri)) S.types.set(sIri, new Set());
      // mark as class-ish
      // (no concrete rdfs:Class required; we'll detect via heuristics below)
    }
    if (pIri === RDFS_DOMAIN || pIri === RDFS_RANGE) {
      if (!S.types.has(sIri)) S.types.set(sIri, new Set());
    }
  }

  // compute kind per IRI based on types + heuristics
  const candidates = new Set();
  for (const q of S.quads) {
    const sIri = iri(q.subject); if (sIri) candidates.add(sIri);
    const oIri = iri(q.object); if (oIri) candidates.add(oIri);
  }

  for (const c of candidates) {
    const t = S.types.get(c) || new Set();
    // heuristics
    const out = S.out.get(c) || [];
    const hasSubClass = out.some(x => iri(x.predicate) === RDFS_SUBCLASS_OF);
    const hasDomRng = out.some(x => {
      const p = iri(x.predicate);
      return p === RDFS_DOMAIN || p === RDFS_RANGE || p === RDFS_SUBPROPERTY_OF;
    });

    let kind = null;
    if (t.has(OWL_CLASS)) kind = 'Class';
    else if (t.has(OWL_OBJECT_PROPERTY)) kind = 'Object property';
    else if (t.has(OWL_DATATYPE_PROPERTY)) kind = 'Data property';
    else if (t.has(OWL_ANNOTATION_PROPERTY)) kind = 'Annotation property';
    else if (t.has(OWL_NAMED_INDIVIDUAL)) kind = 'Individual';
    else if (hasSubClass) kind = 'Class';
    else if (hasDomRng) kind = 'Object property'; // generic "property-ish" => treat as object prop for filtering visibility
    else kind = null;

    if (kind) S.kind.set(c, kind);
  }
}

function buildEntities(){
  const seen = new Set();
  for (const q of S.quads) {
    const sIri = iri(q.subject); if (sIri) seen.add(sIri);
    const oIri = iri(q.object); if (oIri) seen.add(oIri);
  }
  const list = [];
  for (const i of seen) {
    const kind = S.kind.get(i) || null;
    // only show the five target kinds by default; other IRIs can be navigated via "Referenced by" and outgoing links
    const lbl = displayIri(i);
    const def = S.defn.get(i) || '';
    list.push({ iri: i, kind: kind || 'Individual', label: lbl, defKey: def.toLowerCase() });
    // If kind unknown, keep it navigable but categorize as Individual so it can appear (user filters can hide)
  }
  // Normalize unknowns to "Individual" is too strong; instead, keep kind as detected or "Individual" only if typed.
  for (const e of list) {
    if (!S.kind.has(e.iri)) {
      // if it looks like a property or class due to indexes, set earlier; else mark as Individual-ish but don't overwrite actual typed kinds
      const t = S.types.get(e.iri) || new Set();
      if (t.has(OWL_NAMED_INDIVIDUAL)) S.kind.set(e.iri, 'Individual');
      else if ((S.out.get(e.iri)||[]).some(x => iri(x.predicate) === RDFS_SUBCLASS_OF)) S.kind.set(e.iri, 'Class');
      else if ((S.out.get(e.iri)||[]).some(x => [RDFS_DOMAIN,RDFS_RANGE,RDFS_SUBPROPERTY_OF].includes(iri(x.predicate)))) S.kind.set(e.iri, 'Object property');
      else S.kind.set(e.iri, 'Individual'); // keep list usable
    }
    e.kind = S.kind.get(e.iri);
  }

  const rank = (k) => ({'Class':1,'Object property':2,'Data property':3,'Annotation property':4,'Individual':5}[k] || 9);
  list.sort((a,b)=> (rank(a.kind)-rank(b.kind)) || a.label.localeCompare(b.label) || a.iri.localeCompare(b.iri));
  S.entities = list;
}

//////////////////////
// Rendering: Entity list
//////////////////////
function activeSearch(){
  const sb = byId('searchBox');
  return sb ? (sb.value || '').trim().toLowerCase() : '';
}

function entityMatches(e, q){
  if (!S.activeKinds.has(e.kind)) return false;
  if (!q) return true;
  const iriLow = e.iri.toLowerCase();
  return e.label.toLowerCase().includes(q) || iriLow.includes(q) || (e.defKey && e.defKey.includes(q));
}

function renderEntityList(){
  const listNode = byId('entityList');
  if (!listNode) return;
  clear(listNode);

  const q = activeSearch();
  const filtered = S.entities.filter(e => entityMatches(e, q));
  const max = 3000;
  const shown = filtered.slice(0, max);

  for (const e of shown) {
    const row = ce('button', { type:'button' });
    row.textContent = e.label + '  [' + e.kind + ']';
    row.style.display = 'block';
    row.style.width = '100%';
    row.style.textAlign = 'left';
    row.style.margin = '0 0 6px 0';
    row.style.padding = '8px 10px';
    row.style.borderRadius = '8px';
    row.style.border = '1px solid rgba(0,0,0,.15)';
    row.style.background = (S.selected === e.iri) ? 'rgba(120,160,255,.18)' : '';
    row.addEventListener('click', () => selectIri(e.iri));
    listNode.appendChild(row);
  }

  const extra = filtered.length > max ? (' Showing first ' + max.toLocaleString() + ' of ' + filtered.length.toLocaleString() + '.') : (' ' + filtered.length.toLocaleString() + ' shown.');
  setStatus('Entities: ' + S.entities.length.toLocaleString() + '. Matches: ' + filtered.length.toLocaleString() + '.' + extra);
}

//////////////////////
// Rendering: Details
//////////////////////
function selectIri(iriStr){
  S.selected = iriStr;
  renderEntityList(); // refresh selection highlight
  renderDetails(iriStr);
}

function renderDetails(iriStr){
  const details = byId('details');
  if (!details) return;
  clear(details);

  const kind = S.kind.get(iriStr) || 'Individual';
  const h = ce('h2', { text: displayIri(iriStr) });
  details.appendChild(h);

  details.appendChild(kv('IRI', iriButton(iriStr, true)));
  details.appendChild(kv('Kind', ce('span', { text: kind })));

  const def = S.defn.get(iriStr) || '';
  if (def) details.appendChild(kv('Definition', ce('span', { text: def })));

  // parents/children
  const ps = S.parents.get(iriStr);
  const cs = S.children.get(iriStr);
  if (ps && ps.size) details.appendChild(kv('Parents', buttonList([...ps])));
  if (cs && cs.size) details.appendChild(kv('Children', buttonList([...cs])));

  // property bits
  if (kind === 'Object property' || kind === 'Data property' || kind === 'Annotation property') {
    const dom = S.domain.get(iriStr); if (dom && dom.size) details.appendChild(kv('Domain', buttonList([...dom])));
    const rng = S.range.get(iriStr);  if (rng && rng.size) details.appendChild(kv('Range', buttonList([...rng])));
    const inv = S.inverseOf.get(iriStr); if (inv && inv.size) details.appendChild(kv('Inverse of', buttonList([...inv])));
    const spp = S.pParents.get(iriStr); if (spp && spp.size) details.appendChild(kv('Super-properties', buttonList([...spp])));
    const spc = S.pChildren.get(iriStr); if (spc && spc.size) details.appendChild(kv('Sub-properties', buttonList([...spc])));
  }

  // class bits: domainOf/rangeOf
  if (kind === 'Class') {
    const dOf = S.domainOf.get(iriStr); if (dOf && dOf.size) details.appendChild(kv('Properties with this as domain', buttonList([...dOf])));
    const rOf = S.rangeOf.get(iriStr);  if (rOf && rOf.size) details.appendChild(kv('Properties with this as range', buttonList([...rOf])));
  }

  // restrictions / anonymous superclasses from blank nodes in subClassOf and equivalentClass
  const anon = collectAnonExpressions(iriStr);
  if (anon.length) {
    const sec = sectionTitle('Restrictions / Anonymous expressions');
    details.appendChild(sec);
    for (const a of anon) details.appendChild(preBlock(a));
  }

  // outgoing grouped (excluding already shown predicates)
  const dedicated = new Set([RDF_TYPE,RDFS_LABEL,IAO_DEF,SKOS_DEF,RDFS_COMMENT,RDFS_SUBCLASS_OF,RDFS_SUBPROPERTY_OF,RDFS_DOMAIN,RDFS_RANGE,OWL_INVERSE_OF,OWL_EQUIVALENT_CLASS]);
  const outgoing = (S.out.get(iriStr) || []).filter(q => !dedicated.has(iri(q.predicate)));
  if (outgoing.length) {
    details.appendChild(sectionTitle('Other outgoing triples (grouped by predicate)'));
    details.appendChild(groupedTriplesOutgoing(outgoing));
  }

  // incoming grouped: referenced by
  const incoming = (S.inc.get(iriStr) || []);
  if (incoming.length) {
    details.appendChild(sectionTitle('Referenced by (incoming triples grouped by predicate)'));
    details.appendChild(groupedIncoming(incoming));
  }
}

function kv(k, vNode){
  const wrap = ce('div');
  wrap.style.display = 'grid';
  wrap.style.gridTemplateColumns = '160px 1fr';
  wrap.style.gap = '10px';
  wrap.style.padding = '6px 0';
  const kk = ce('div', { text: k });
  kk.style.opacity = '0.75';
  kk.style.fontSize = '13px';
  const vv = ce('div');
  vv.appendChild(vNode);
  wrap.appendChild(kk); wrap.appendChild(vv);
  return wrap;
}

function sectionTitle(t){
  const h = ce('h3', { text: t });
  h.style.marginTop = '14px';
  return h;
}

function preBlock(text){
  const pre = ce('pre', { text: text });
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.padding = '10px';
  pre.style.border = '1px solid rgba(0,0,0,.15)';
  pre.style.borderRadius = '10px';
  pre.style.background = 'rgba(0,0,0,.03)';
  return pre;
}

function iriButton(iriStr, isMono){
  const b = ce('button', { type:'button' });
  b.textContent = iriStr;
  b.addEventListener('click', () => selectIri(iriStr));
  b.style.cursor = 'pointer';
  b.style.maxWidth = '100%';
  b.style.overflow = 'hidden';
  b.style.textOverflow = 'ellipsis';
  b.style.whiteSpace = 'nowrap';
  b.style.padding = '4px 8px';
  b.style.borderRadius = '999px';
  b.style.border = '1px solid rgba(0,0,0,.18)';
  b.style.background = 'transparent';
  if (isMono) b.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  b.title = iriStr;
  return b;
}

function buttonList(iris){
  const wrap = ce('div');
  wrap.style.display = 'flex';
  wrap.style.flexWrap = 'wrap';
  wrap.style.gap = '6px';
  iris.sort((a,b)=>displayIri(a).localeCompare(displayIri(b)));
  for (const i of iris) {
    const btn = ce('button', { type:'button' });
    btn.textContent = displayIri(i);
    btn.title = i;
    btn.style.padding = '4px 8px';
    btn.style.borderRadius = '999px';
    btn.style.border = '1px solid rgba(0,0,0,.18)';
    btn.style.background = 'rgba(0,0,0,.02)';
    btn.addEventListener('click', () => selectIri(i));
    wrap.appendChild(btn);
  }
  return wrap;
}

//////////////////////
// Grouping outgoing/incoming
//////////////////////
function groupedTriplesOutgoing(triples){
  const box = ce('div');
  const byPred = new Map();
  for (const q of triples) {
    const p = iri(q.predicate) || termText(q.predicate);
    if (!byPred.has(p)) byPred.set(p, []);
    byPred.get(p).push(q);
  }
  const preds = [...byPred.keys()].sort((a,b)=>displayIri(a).localeCompare(displayIri(b)));
  for (const p of preds) {
    const head = ce('div', { text: displayIri(p) });
    head.style.marginTop = '10px';
    head.style.fontWeight = '600';
    box.appendChild(head);

    const ul = ce('ul');
    ul.style.margin = '6px 0 0 18px';
    for (const q of byPred.get(p)) {
      const li = ce('li');
      const obj = q.object;
      li.appendChild(renderObjectTerm(obj));
      // If blank node, add a short expression dump
      if (isBlankNode(obj)) {
        const txt = renderAnon(obj.value);
        if (txt) li.appendChild(ce('span', { text: '  ' + txt }));
      }
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  return box;
}

function groupedIncoming(triples){
  const box = ce('div');
  const byPred = new Map();
  for (const q of triples) {
    const p = iri(q.predicate) || termText(q.predicate);
    if (!byPred.has(p)) byPred.set(p, []);
    byPred.get(p).push(q);
  }
  const preds = [...byPred.keys()].sort((a,b)=>displayIri(a).localeCompare(displayIri(b)));
  for (const p of preds) {
    const head = ce('div', { text: displayIri(p) });
    head.style.marginTop = '10px';
    head.style.fontWeight = '600';
    box.appendChild(head);

    const ul = ce('ul');
    ul.style.margin = '6px 0 0 18px';
    for (const q of byPred.get(p)) {
      const li = ce('li');
      const sIri = iri(q.subject);
      if (sIri) {
        const btn = ce('button', { type:'button' });
        btn.textContent = displayIri(sIri);
        btn.title = sIri;
        btn.style.padding = '2px 6px';
        btn.style.borderRadius = '8px';
        btn.style.border = '1px solid rgba(0,0,0,.18)';
        btn.style.background = 'rgba(0,0,0,.02)';
        btn.addEventListener('click', () => selectIri(sIri));
        li.appendChild(btn);
      } else {
        li.textContent = termText(q.subject);
      }
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  return box;
}

function renderObjectTerm(t){
  if (isNamedNode(t)) {
    const btn = ce('button', { type:'button' });
    btn.textContent = displayIri(t.value);
    btn.title = t.value;
    btn.style.padding = '2px 6px';
    btn.style.borderRadius = '8px';
    btn.style.border = '1px solid rgba(0,0,0,.18)';
    btn.style.background = 'rgba(0,0,0,.02)';
    btn.addEventListener('click', () => selectIri(t.value));
    return btn;
  }
  if (isLiteral(t)) return ce('span', { text: termText(t) });
  if (isBlankNode(t)) return ce('span', { text: '_:' + t.value });
  return ce('span', { text: termText(t) });
}

//////////////////////
// Anonymous expressions (OWL restrictions, boolean class expressions, rdf:List)
//////////////////////
function collectAnonExpressions(classIri){
  const out = [];
  const quads = S.out.get(classIri) || [];
  for (const q of quads) {
    const p = iri(q.predicate);
    if (p !== RDFS_SUBCLASS_OF && p !== OWL_EQUIVALENT_CLASS) continue;
    if (isBlankNode(q.object)) {
      const txt = renderAnon(q.object.value);
      if (txt) out.push((p === RDFS_SUBCLASS_OF ? 'subClassOf ' : 'equivalentClass ') + txt);
      else out.push((p === RDFS_SUBCLASS_OF ? 'subClassOf ' : 'equivalentClass ') + '_:' + q.object.value);
    }
  }
  return out;
}

function renderAnon(bnid){
  const qs = S.bnodes.get(bnid) || [];
  if (!qs.length) return '';

  const objOf = (predIri) => {
    const q = qs.find(x => iri(x.predicate) === predIri);
    return q ? q.object : null;
  };
  const hasType = (typeIri) => qs.some(x => iri(x.predicate) === RDF_TYPE && iri(x.object) === typeIri);

  // Restriction
  if (hasType(OWL_RESTRICTION)) {
    const onP = objOf(OWL_ON_PROPERTY);
    const some = objOf(OWL_SOME_VALUES_FROM);
    const all = objOf(OWL_ALL_VALUES_FROM);
    const hasV = objOf(OWL_HAS_VALUE);
    const minC = objOf(OWL_MIN_CARDINALITY);
    const maxC = objOf(OWL_MAX_CARDINALITY);
    const card = objOf(OWL_CARDINALITY);

    const pTxt = isNamedNode(onP) ? displayIri(onP.value) : (onP ? termText(onP) : '(no onProperty)');
    if (some) return 'Restriction(on ' + pTxt + ' some ' + renderTermExpr(some) + ')';
    if (all)  return 'Restriction(on ' + pTxt + ' only ' + renderTermExpr(all) + ')';
    if (hasV) return 'Restriction(on ' + pTxt + ' value ' + renderTermExpr(hasV) + ')';
    if (card) return 'Restriction(on ' + pTxt + ' exactly ' + renderTermExpr(card) + ')';
    if (minC) return 'Restriction(on ' + pTxt + ' min ' + renderTermExpr(minC) + ')';
    if (maxC) return 'Restriction(on ' + pTxt + ' max ' + renderTermExpr(maxC) + ')';
    return 'Restriction(on ' + pTxt + ')';
  }

  // Boolean class expressions
  const inter = objOf(OWL_INTERSECTION_OF);
  if (isBlankNode(inter)) {
    const items = readList(inter.value).map(renderTermExpr).filter(Boolean);
    if (items.length) return 'intersectionOf(' + items.join(' AND ') + ')';
  }
  const uni = objOf(OWL_UNION_OF);
  if (isBlankNode(uni)) {
    const items = readList(uni.value).map(renderTermExpr).filter(Boolean);
    if (items.length) return 'unionOf(' + items.join(' OR ') + ')';
  }
  const comp = objOf(OWL_COMPLEMENT_OF);
  if (comp) return 'complementOf(' + renderTermExpr(comp) + ')';

  // Fallback: dump predicates succinctly
  const parts = [];
  for (const q of qs) {
    const p = iri(q.predicate);
    if (!p) continue;
    if (p === RDF_TYPE) continue;
    parts.push(shortIri(p) + ' ' + renderTermExpr(q.object));
  }
  if (parts.length) return '_:' + bnid + ' {' + parts.slice(0, 8).join('; ') + (parts.length>8?'; …':'') + '}';
  return '_:' + bnid;
}

function renderTermExpr(t){
  if (isNamedNode(t)) return displayIri(t.value);
  if (isLiteral(t)) return termText(t);
  if (isBlankNode(t)) return renderAnon(t.value) || ('_:' + t.value);
  return termText(t);
}

function readList(headBnodeId){
  const out = [];
  let cur = headBnodeId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const qs = S.bnodes.get(cur) || [];
    const firstQ = qs.find(x => iri(x.predicate) === RDF_FIRST);
    const restQ = qs.find(x => iri(x.predicate) === RDF_REST);
    if (firstQ) out.push(firstQ.object);
    if (!restQ) break;
    if (isNamedNode(restQ.object) && restQ.object.value === RDF_NIL) break;
    if (isBlankNode(restQ.object)) cur = restQ.object.value;
    else break;
  }
  return out;
}

function shortIri(iriStr){
  // simple prefix compacting for display in anon dumps
  for (const pfx of Object.keys(S.prefixes || {})) {
    const ns = S.prefixes[pfx];
    if (ns && iriStr.startsWith(ns)) return pfx + ':' + iriStr.slice(ns.length);
  }
  return displayIri(iriStr);
}

//////////////////////
// wireUi (defensive)
//////////////////////
function wireUi(){
  // Filters
  try {
    const cbs = document.querySelectorAll('.filters input[type="checkbox"][data-kind]');
    if (cbs && cbs.length) {
      for (const cb of cbs) {
        const kind = cb.getAttribute('data-kind');
        if (!kind) continue;
        // initialize from checked state
        if (cb.checked) S.activeKinds.add(kind);
        else S.activeKinds.delete(kind);
        cb.addEventListener('change', () => {
          if (cb.checked) S.activeKinds.add(kind);
          else S.activeKinds.delete(kind);
          renderEntityList();
        });
      }
    }
  } catch(_e){ /* defensive */ }

  // Search
  const sb = byId('searchBox');
  if (sb) sb.addEventListener('input', () => renderEntityList());

  // Load button
  const btn = byId('loadOntology');
  if (btn) btn.addEventListener('click', () => loadSelectedOntology());

  // Dropdown change (optional convenience)
  const sel = byId('ontologySelect');
  if (sel) sel.addEventListener('change', () => { /* do nothing until load click */ });

  // Initial catalog load
  loadCatalog();
}

document.addEventListener('DOMContentLoaded', wireUi);
