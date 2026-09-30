"use strict";

/**
 * Static Ontology Browser
 * ----------------------
 * - Runs entirely in the browser (GitHub Pages friendly)
 * - Parses Turtle with N3.js (loaded via CDN in index.html)
 * - Builds indexes for:
 *     * classes, properties (object/datatype/annotation), individuals
 *     * outgoing and incoming triples for every node
 * - Renders:
 *     * entity list with search + type filters
 *     * details view with label/definition/comments
 *     * ALL outgoing triples and ALL incoming triples
 *
 * Notes:
 * - This is a lightweight browser, not a full OWL reasoner.
 * - It shows asserted triples only (no inference).
 */

/* global N3 */

//////////////////////
// Vocabulary constants
//////////////////////

const RDF_TYPE                = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDF_PROPERTY            = "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property";
const RDF_FIRST               = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
const RDF_REST                = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
const RDF_NIL                 = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";

const RDFS_CLASS              = "http://www.w3.org/2000/01/rdf-schema#Class";
const RDFS_LABEL              = "http://www.w3.org/2000/01/rdf-schema#label";
const RDFS_COMMENT            = "http://www.w3.org/2000/01/rdf-schema#comment";
const RDFS_SUBCLASS_OF        = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDFS_SUBPROPERTY_OF     = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
const RDFS_DOMAIN             = "http://www.w3.org/2000/01/rdf-schema#domain";
const RDFS_RANGE              = "http://www.w3.org/2000/01/rdf-schema#range";

const OWL_CLASS               = "http://www.w3.org/2002/07/owl#Class";
const OWL_NAMED_INDIVIDUAL    = "http://www.w3.org/2002/07/owl#NamedIndividual";
const OWL_OBJECT_PROPERTY     = "http://www.w3.org/2002/07/owl#ObjectProperty";
const OWL_DATATYPE_PROPERTY   = "http://www.w3.org/2002/07/owl#DatatypeProperty";
const OWL_ANNOTATION_PROPERTY = "http://www.w3.org/2002/07/owl#AnnotationProperty";
const OWL_ONTOLOGY            = "http://www.w3.org/2002/07/owl#Ontology";

const OWL_INVERSE_OF          = "http://www.w3.org/2002/07/owl#inverseOf";
const OWL_EQUIVALENT_CLASS    = "http://www.w3.org/2002/07/owl#equivalentClass";

const OWL_ON_PROPERTY         = "http://www.w3.org/2002/07/owl#onProperty";
const OWL_SOME_VALUES_FROM    = "http://www.w3.org/2002/07/owl#someValuesFrom";
const OWL_ALL_VALUES_FROM     = "http://www.w3.org/2002/07/owl#allValuesFrom";
const OWL_HAS_VALUE           = "http://www.w3.org/2002/07/owl#hasValue";
const OWL_MIN_CARDINALITY     = "http://www.w3.org/2002/07/owl#minCardinality";
const OWL_MAX_CARDINALITY     = "http://www.w3.org/2002/07/owl#maxCardinality";
const OWL_CARDINALITY         = "http://www.w3.org/2002/07/owl#cardinality";

const OWL_INTERSECTION_OF     = "http://www.w3.org/2002/07/owl#intersectionOf";
const OWL_UNION_OF            = "http://www.w3.org/2002/07/owl#unionOf";
const OWL_COMPLEMENT_OF       = "http://www.w3.org/2002/07/owl#complementOf";

const IAO_DEFINITION          = "http://purl.obolibrary.org/obo/IAO_0000115";
const SKOS_DEFINITION         = "http://www.w3.org/2004/02/skos/core#definition";

// Used only to show nicer details; all triples are still shown separately.
const HANDLED_PREDICATES = new Set([
  RDF_TYPE,
  RDFS_LABEL,
  RDFS_COMMENT,
  IAO_DEFINITION,
  SKOS_DEFINITION,
  RDFS_SUBCLASS_OF,
  RDFS_SUBPROPERTY_OF,
  RDFS_DOMAIN,
  RDFS_RANGE,
  OWL_INVERSE_OF,
  OWL_EQUIVALENT_CLASS,
]);

//////////////////////
// State
//////////////////////

const state = {
  // raw quads (N3 quads)
  store: [],

  // prefix maps for CURIE display (from parsed prefixes)
  prefixes: {},

  // label / definition / comment maps
  labels: new Map(),        // iri -> string
  definitions: new Map(),   // iri -> string
  comments: new Map(),      // iri -> string (first)

  // all entities known (subject/object IRIs and selected bnodes)
  entities: [],             // array of { iri, kind, label, sortKey }

  // kinds and type info
  kinds: new Map(),         // iri -> kind string

  // outgoing and incoming indexes
  outgoing: new Map(),      // iri -> Array<quad>
  incoming: new Map(),      // iri -> Array<quad>

  // bnode description index (bnid -> Array<quad>) where bnode is subject
  blankNodes: new Map(),

  // relationship indexes for convenience
  parents: new Map(),       // child -> Set(parent)
  children: new Map(),      // parent -> Set(child)
  subPropParents: new Map(),// childProp -> Set(parentProp)
  subPropChildren: new Map(),// parentProp -> Set(childProp)
  domainOf: new Map(),      // class -> Set(property)
  rangeOf: new Map(),       // class -> Set(property)

  // UI
  activeFilters: new Set(["Class", "Object property", "Data property", "Annotation property", "Individual"]),
  activeOntology: null,
  activeEntity: null,
};

//////////////////////
// DOM helpers
//////////////////////

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  }
  for (const c of children) n.append(c);
  return n;
};

const escapeHtml = (s) => String(s)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

//////////////////////
// CURIE + label helpers
//////////////////////

function isIri(x) {
  return typeof x === "string" && (x.startsWith("http://") || x.startsWith("https://"));
}

function termToString(term) {
  // term is an N3 term
  if (!term) return "";
  if (term.termType === "NamedNode") return term.value;
  if (term.termType === "BlankNode") return "_:" + term.value;
  if (term.termType === "Literal") return `"${term.value}"${term.language ? "@" + term.language : ""}${term.datatype && term.datatype.value !== "http://www.w3.org/2001/XMLSchema#string" ? "^^<" + term.datatype.value + ">" : ""}`;
  if (term.termType === "DefaultGraph") return "";
  return String(term.value ?? term);
}

function iriToCurie(iri) {
  if (!iri) return "";
  for (const [pfx, ns] of Object.entries(state.prefixes)) {
    if (iri.startsWith(ns)) return `${pfx}:${iri.slice(ns.length)}`;
  }
  return `<${iri}>`;
}

function displayName(iri) {
  const lbl = state.labels.get(iri);
  if (lbl) return lbl;
  // use CURIE if possible; otherwise last path fragment
  const curie = iriToCurie(iri);
  if (curie && !curie.startsWith("<")) return curie;
  try {
    const u = new URL(iri);
    const frag = u.hash ? u.hash.slice(1) : "";
    if (frag) return frag;
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : iri;
  } catch {
    return iri;
  }
}

function kindRank(kind) {
  // for sorting: classes first, then properties, then individuals, then other
  const order = {
    "Class": 1,
    "Object property": 2,
    "Data property": 3,
    "Annotation property": 4,
    "Property": 5,
    "Individual": 6,
    "Ontology": 7,
    "Other": 99,
  };
  return order[kind] ?? 50;
}

//////////////////////
// Parsing + indexing
//////////////////////

async function fetchText(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status} ${r.statusText}`);
  return await r.text();
}

async function loadCatalog() {
  const url = "./ontologies/catalog.json";
  const txt = await fetchText(url);
  const cat = JSON.parse(txt);

  // Support both: a plain array, or an object with an "ontologies" array.
  const list = Array.isArray(cat) ? cat : (cat.ontologies ?? []);

  const select = $("#ontologySelect");
  select.innerHTML = "";

  for (const item of list) {
    // Support both key styles: {title,file} and {name,path}.
    const path = item.file ?? item.path;
    const name = item.title ?? item.name ?? path;
    const opt = el("option", { value: path }, [document.createTextNode(name)]);
    select.append(opt);
  }

  if (list.length === 0) {
    setStatus("No ontologies listed in ontologies/catalog.json", true);
    return;
  }

  select.addEventListener("change", () => loadOntology(select.value));

  // Load default (object form may specify cat.default; otherwise first entry).
  const defaultPath = (!Array.isArray(cat) && cat.default)
    ? cat.default
    : (list[0].file ?? list[0].path);

  select.value = defaultPath;
  await loadOntology(defaultPath);
}

function clearStateForNewOntology() {
  state.store = [];
  state.prefixes = {};
  state.labels.clear();
  state.definitions.clear();
  state.comments.clear();
  state.entities = [];
  state.kinds.clear();
  state.outgoing.clear();
  state.incoming.clear();
  state.blankNodes.clear();
  state.parents.clear();
  state.children.clear();
  state.subPropParents.clear();
  state.subPropChildren.clear();
  state.domainOf.clear();
  state.rangeOf.clear();
  state.activeEntity = null;
}

async function loadOntology(path) {
  clearStateForNewOntology();
  state.activeOntology = path;

  setStatus(`Loading ${path} …`);
  $("#details").innerHTML = `<div class="placeholder"><h2>Loading…</h2><p class="mono">${escapeHtml(path)}</p></div>`;
  $("#entityList").innerHTML = "";

  const ttl = await fetchText(path);

  // Parse TTL with N3.js
  const parser = new N3.Parser({ format: "text/turtle" });
  const quads = [];
  const prefixes = {};

  await new Promise((resolve, reject) => {
    parser.parse(ttl, (err, quad, pref) => {
      if (err) return reject(err);
      if (pref) {
        Object.assign(prefixes, pref);
      }
      if (quad) quads.push(quad);
      else resolve();
    });
  });

  state.store = quads;
  state.prefixes = prefixes;

  buildIndexes();
  buildEntityIndex();
  renderSummary();
  renderEntityList();

  setStatus(`Loaded ${quads.length.toLocaleString()} triples from ${path}`);
}

function pushMapArray(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function pushMapSet(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function buildIndexes() {
  // First pass: outgoing/incoming and blank nodes
  for (const q of state.store) {
    const s = q.subject.termType === "NamedNode" ? q.subject.value : null;
    const p = q.predicate.termType === "NamedNode" ? q.predicate.value : null;

    if (q.subject.termType === "BlankNode") {
      pushMapArray(state.blankNodes, q.subject.value, q);
    }

    if (s) pushMapArray(state.outgoing, s, q);

    // incoming only for object named nodes
    if (q.object.termType === "NamedNode") {
      pushMapArray(state.incoming, q.object.value, q);
    }
    if (q.object.termType === "BlankNode") {
      // also index incoming for bnode so we can render a bnode with context if selected (rare)
      pushMapArray(state.incoming, "_:" + q.object.value, q);
    }

    // labels/defs/comments on NamedNodes
    if (s && p === RDFS_LABEL && q.object.termType === "Literal") {
      if (!state.labels.has(s)) state.labels.set(s, q.object.value);
    }
    if (s && (p === IAO_DEFINITION || p === SKOS_DEFINITION) && q.object.termType === "Literal") {
      if (!state.definitions.has(s)) state.definitions.set(s, q.object.value);
    }
    if (s && p === RDFS_COMMENT && q.object.termType === "Literal") {
      if (!state.comments.has(s)) state.comments.set(s, q.object.value);
    }

    // class hierarchy
    if (s && p === RDFS_SUBCLASS_OF && q.object.termType === "NamedNode") {
      const parent = q.object.value;
      pushMapSet(state.parents, s, parent);
      pushMapSet(state.children, parent, s);
    }

    // property hierarchy
    if (s && p === RDFS_SUBPROPERTY_OF && q.object.termType === "NamedNode") {
      const parent = q.object.value;
      pushMapSet(state.subPropParents, s, parent);
      pushMapSet(state.subPropChildren, parent, s);
    }

    // domain/range convenience
    if (s && p === RDFS_DOMAIN && q.object.termType === "NamedNode") {
      pushMapSet(state.domainOf, q.object.value, s);
    }
    if (s && p === RDFS_RANGE && q.object.termType === "NamedNode") {
      pushMapSet(state.rangeOf, q.object.value, s);
    }
  }
}

function detectKinds(typesSet) {
  // Given a Set of rdf:type IRIs, return a normalized kind string
  const has = (t) => typesSet.has(t);
  if (has(OWL_ONTOLOGY)) return "Ontology";
  if (has(OWL_CLASS) || has(RDFS_CLASS)) return "Class";
  if (has(OWL_OBJECT_PROPERTY)) return "Object property";
  if (has(OWL_DATATYPE_PROPERTY)) return "Data property";
  if (has(OWL_ANNOTATION_PROPERTY)) return "Annotation property";
  if (has(RDF_PROPERTY)) return "Property";
  if (has(OWL_NAMED_INDIVIDUAL)) return "Individual";

  // heuristic: if it appears as subject of subClassOf => class; subPropertyOf => property
  return "Other";
}

function buildEntityIndex() {
  // gather candidate IRIs
  const candidates = new Set();

  for (const q of state.store) {
    if (q.subject.termType === "NamedNode") candidates.add(q.subject.value);
    if (q.object.termType === "NamedNode") candidates.add(q.object.value);
  }

  // compute rdf:types per iri
  const typesByIri = new Map();
  for (const iri of candidates) typesByIri.set(iri, new Set());

  for (const q of state.store) {
    if (q.subject.termType === "NamedNode" && q.predicate.value === RDF_TYPE && q.object.termType === "NamedNode") {
      const s = q.subject.value;
      if (typesByIri.has(s)) typesByIri.get(s).add(q.object.value);
    }
  }

  // add heuristics
  for (const iri of candidates) {
    const tset = typesByIri.get(iri) ?? new Set();
    const out = state.outgoing.get(iri) ?? [];

    // heuristic: if has rdfs:subClassOf => Class
    if (out.some(q => q.predicate.value === RDFS_SUBCLASS_OF)) {
      tset.add(RDFS_CLASS);
    }
    // heuristic: if has rdfs:subPropertyOf/domain/range => Property
    if (out.some(q => [RDFS_SUBPROPERTY_OF, RDFS_DOMAIN, RDFS_RANGE].includes(q.predicate.value))) {
      tset.add(RDF_PROPERTY);
    }
    // heuristic: if appears as subject but no explicit type and has some predicate other than rdf:type
    if (!tset.size && out.some(q => q.predicate.value !== RDF_TYPE)) {
      // could still be an individual
      tset.add(OWL_NAMED_INDIVIDUAL);
    }

    const kind = detectKinds(tset);
    state.kinds.set(iri, kind);
  }

  // Build entities array
  state.entities = [...candidates].map(iri => {
    const kind = state.kinds.get(iri) ?? "Other";
    const lbl = displayName(iri);
    return {
      iri,
      kind,
      label: lbl,
      sortKey: `${String(kindRank(kind)).padStart(2, "0")}|${lbl.toLowerCase()}|${iri.toLowerCase()}`
    };
  }).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

//////////////////////
// Rendering: list + details
//////////////////////

function renderSummary() {
  const counts = new Map();
  for (const e of state.entities) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const total = state.entities.length;

  const bits = [
    `${total.toLocaleString()} entities`,
    ...["Class", "Object property", "Data property", "Annotation property", "Individual", "Property", "Other"]
      .filter(k => counts.has(k))
      .map(k => `${k}: ${counts.get(k).toLocaleString()}`),
  ];
  $("#summary").textContent = bits.join(" • ");
}

function setStatus(msg, isError = false) {
  const st = $("#status");
  st.textContent = msg ?? "";
  st.classList.toggle("bad", Boolean(isError));
}

function entityMatchesFilters(e) {
  return state.activeFilters.has(e.kind);
}

function entityMatchesSearch(e, q) {
  if (!q) return true;
  const needle = q.toLowerCase().trim();
  if (!needle) return true;
  const curie = iriToCurie(e.iri).toLowerCase();
  return (
    e.label.toLowerCase().includes(needle) ||
    e.iri.toLowerCase().includes(needle) ||
    curie.includes(needle)
  );
}

function renderEntityList() {
  const list = $("#entityList");
  list.innerHTML = "";

  const q = $("#searchInput").value ?? "";
  const filtered = state.entities.filter(e => entityMatchesFilters(e) && entityMatchesSearch(e, q));

  // keep list manageable (client-side)
  const MAX = 2500;
  const shown = filtered.slice(0, MAX);

  for (const e of shown) {
    const item = el("div", {
      class: "entityItem" + (state.activeEntity === e.iri ? " active" : ""),
      role: "option",
      tabindex: "0",
      "data-iri": e.iri,
      onclick: () => selectEntity(e.iri),
      onkeydown: (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          selectEntity(e.iri);
        }
      }
    }, [
      el("div", { class: "entityTop" }, [
        el("span", { class: "kindBadge" }, [document.createTextNode(e.kind)]),
        el("span", { class: "entityLabel" }, [document.createTextNode(e.label)])
      ]),
      el("div", { class: "entityIri mono" }, [document.createTextNode(iriToCurie(e.iri))])
    ]);
    list.append(item);
  }

  const tail = filtered.length > MAX ? `Showing first ${MAX.toLocaleString()} of ${filtered.length.toLocaleString()} matches. Refine search.` : `${filtered.length.toLocaleString()} matches.`;
  setStatus(tail);
}

function selectEntity(iri) {
  state.activeEntity = iri;
  // update list selection styling
  for (const node of document.querySelectorAll(".entityItem")) {
    node.classList.toggle("active", node.getAttribute("data-iri") === iri);
  }
  renderDetails(iri);
}

function renderDetails(iri) {
  const kind = state.kinds.get(iri) ?? "Other";
  const lbl = displayName(iri);
  const defn = state.definitions.get(iri);
  const comm = state.comments.get(iri);

  const outgoing = (state.outgoing.get(iri) ?? []).slice();
  const incoming = (state.incoming.get(iri) ?? []).slice();

  // Sort triples by predicate then object string for stable viewing
  outgoing.sort((a, b) => (a.predicate.value + "|" + termToString(a.object)).localeCompare(b.predicate.value + "|" + termToString(b.object)));
  incoming.sort((a, b) => (a.predicate.value + "|" + termToString(a.subject)).localeCompare(b.predicate.value + "|" + termToString(b.subject)));

  const details = $("#details");
  details.innerHTML = "";

  const header = el("div", { class: "hrow" }, [
    el("div", {}, [
      el("h2", {}, [document.createTextNode(lbl)]),
      el("div", { class: "mono", style: "color: var(--muted); margin-top:6px; word-break: break-all" }, [
        document.createTextNode(iriToCurie(iri) + " "),
        isIri(iri) ? el("a", { href: iri, target: "_blank", rel: "noopener" }, [document.createTextNode("open")]) : document.createTextNode("")
      ])
    ]),
    el("div", { class: "pills" }, [
      el("span", { class: "pill" }, [document.createTextNode(kind)]),
      el("span", { class: "pill" }, [document.createTextNode(`Outgoing: ${outgoing.length.toLocaleString()}`)]),
      el("span", { class: "pill" }, [document.createTextNode(`Incoming: ${incoming.length.toLocaleString()}`)]),
    ])
  ]);

  details.append(header);

  // short description section (label/def/comment + key relationships)
  const desc = el("div", { class: "section" }, [el("h3", {}, [document.createTextNode("Overview")])]);

  const kvs = [];

  kvs.push(kvRow("IRI", el("span", { class: "mono" }, [document.createTextNode(iri)])));

  if (defn) kvs.push(kvRow("Definition", el("span", {}, [document.createTextNode(defn)])));
  if (comm) kvs.push(kvRow("Comment", el("span", {}, [document.createTextNode(comm)])));

  // parents/children for class, sub/super properties for properties
  if (kind === "Class") {
    kvs.push(kvRow("Parents", renderIriSet(state.parents.get(iri))));
    kvs.push(kvRow("Children", renderIriSet(state.children.get(iri))));
    kvs.push(kvRow("Domain of", renderIriSet(state.domainOf.get(iri))));
    kvs.push(kvRow("Range of", renderIriSet(state.rangeOf.get(iri))));
  } else if (kind.includes("property") || kind === "Property") {
    kvs.push(kvRow("Super-properties", renderIriSet(state.subPropParents.get(iri))));
    kvs.push(kvRow("Sub-properties", renderIriSet(state.subPropChildren.get(iri))));
  }

  for (const row of kvs) if (row) desc.append(row);
  details.append(desc);

  // render outgoing triples
  details.append(renderTripleSection("Outgoing triples (subject = selected entity)", outgoing, /*flip*/false));

  // render incoming triples
  details.append(renderTripleSection("Incoming triples (object = selected entity)", incoming, /*flip*/true));
}

function kvRow(key, valueNode) {
  if (!valueNode) return null;
  return el("div", { class: "kv" }, [
    el("div", { class: "k" }, [document.createTextNode(key)]),
    el("div", { class: "v" }, [valueNode]),
  ]);
}

function renderIriSet(set) {
  if (!set || set.size === 0) return el("span", { class: "mono", style: "color: var(--muted)" }, [document.createTextNode("—")]);
  const items = [...set].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const wrap = el("div", { style: "display:flex; flex-wrap:wrap; gap:8px" });
  for (const iri of items) {
    wrap.append(renderEntityLink(iri));
  }
  return wrap;
}

function renderEntityLink(iri) {
  const a = el("a", {
    href: "#",
    onclick: (ev) => {
      ev.preventDefault();
      selectEntity(iri);
      // scroll sidebar selection into view if possible
      const node = document.querySelector(`.entityItem[data-iri="${CSS.escape(iri)}"]`);
      if (node) node.scrollIntoView({ block: "nearest" });
    }
  }, [document.createTextNode(displayName(iri))]);

  const badge = el("span", { class: "pill", style: "padding:4px 8px" }, [
    document.createTextNode(state.kinds.get(iri) ?? "Other")
  ]);

  return el("span", { style: "display:inline-flex; gap:6px; align-items:center; border:1px solid rgba(255,255,255,.10); padding:5px 8px; border-radius:999px; background: rgba(0,0,0,.10)" }, [
    a,
    badge
  ]);
}

function renderTripleSection(title, triples, flip) {
  const sec = el("div", { class: "section" }, [
    el("h3", {}, [document.createTextNode(title)])
  ]);

  if (!triples.length) {
    sec.append(el("div", { class: "mono", style: "color: var(--muted)" }, [document.createTextNode("—")]));
    return sec;
  }

  // Table header depends on flip
  const table = el("table", { class: "table" });
  const thead = el("thead", {}, [
    el("tr", {}, [
      el("th", {}, [document.createTextNode(flip ? "Subject" : "Predicate")]),
      el("th", {}, [document.createTextNode(flip ? "Predicate" : "Object")]),
      el("th", {}, [document.createTextNode("Context / Details")]),
    ])
  ]);
  table.append(thead);

  const tbody = el("tbody");

  for (const q of triples) {
    const subj = q.subject;
    const pred = q.predicate;
    const obj  = q.object;

    const predIri = pred.termType === "NamedNode" ? pred.value : null;

    const cell1 = flip ? renderTermAsNode(subj) : renderTermAsNode(pred);
    const cell2 = flip ? renderTermAsNode(pred) : renderTermAsNode(obj);

    // Context: small helper for OWL class expressions / bnode objects
    let ctx = "";
    if (predIri && [RDFS_SUBCLASS_OF, OWL_EQUIVALENT_CLASS].includes(predIri) && obj.termType === "BlankNode") {
      ctx = renderClassExpression(obj.value);
    } else if (obj.termType === "BlankNode") {
      ctx = renderBlankNodeSummary(obj.value);
    } else {
      ctx = "";
    }

    const ctxNode = ctx
      ? el("div", { class: "mono", style: "color: var(--muted); white-space: pre-wrap" }, [document.createTextNode(ctx)])
      : el("span", { class: "mono", style: "color: var(--muted)" }, [document.createTextNode("")]);

    const tr = el("tr", {}, [
      el("td", {}, [cell1]),
      el("td", {}, [cell2]),
      el("td", {}, [ctxNode]),
    ]);
    tbody.append(tr);
  }

  table.append(tbody);
  sec.append(table);
  return sec;
}

function renderTermAsNode(term) {
  if (!term) return el("span", {}, [document.createTextNode("")]);

  if (term.termType === "NamedNode") {
    const iri = term.value;
    return el("span", {}, [
      el("a", {
        href: "#",
        onclick: (ev) => { ev.preventDefault(); selectEntity(iri); }
      }, [document.createTextNode(displayName(iri))]),
      el("span", { class: "mono", style: "color: var(--muted); margin-left:8px" }, [document.createTextNode(iriToCurie(iri))]),
    ]);
  }

  if (term.termType === "BlankNode") {
    const id = term.value;
    const s = renderBlankNodeSummary(id);
    return el("span", { class: "mono" }, [document.createTextNode("_:" + id + (s ? " " + s : ""))]);
  }

  if (term.termType === "Literal") {
    const dt = term.datatype?.value;
    const lang = term.language;
    const suffix = lang ? `@${lang}` : (dt && dt !== "http://www.w3.org/2001/XMLSchema#string" ? `^^${iriToCurie(dt)}` : "");
    return el("span", { class: "mono" }, [document.createTextNode(`"${term.value}"${suffix}`)]);
  }

  return el("span", { class: "mono" }, [document.createTextNode(termToString(term))]);
}

//////////////////////
// Blank node + OWL expression rendering (best-effort)
//////////////////////

function renderBlankNodeSummary(bnid) {
  const quads = state.blankNodes.get(bnid) ?? [];
  if (!quads.length) return "";

  // Try common OWL restriction patterns
  const getObj = (predIri) => {
    const q = quads.find(x => x.predicate.termType === "NamedNode" && x.predicate.value === predIri);
    return q ? q.object : null;
  };

  const onProp = getObj(OWL_ON_PROPERTY);
  const some = getObj(OWL_SOME_VALUES_FROM);
  const all  = getObj(OWL_ALL_VALUES_FROM);
  const hasV = getObj(OWL_HAS_VALUE);
  const minC = getObj(OWL_MIN_CARDINALITY);
  const maxC = getObj(OWL_MAX_CARDINALITY);
  const card = getObj(OWL_CARDINALITY);

  if (onProp && (some || all || hasV || minC || maxC || card)) {
    const p = onProp.termType === "NamedNode" ? displayName(onProp.value) : termToString(onProp);
    if (some) return `[Restriction] on ${p} some ${renderTermCompact(some)}`;
    if (all)  return `[Restriction] on ${p} only ${renderTermCompact(all)}`;
    if (hasV) return `[Restriction] on ${p} value ${renderTermCompact(hasV)}`;
    if (card) return `[Restriction] on ${p} exactly ${renderTermCompact(card)}`;
    if (minC) return `[Restriction] on ${p} min ${renderTermCompact(minC)}`;
    if (maxC) return `[Restriction] on ${p} max ${renderTermCompact(maxC)}`;
  }

  // Try collection based expressions
  const inter = getObj(OWL_INTERSECTION_OF);
  const uni   = getObj(OWL_UNION_OF);
  const comp  = getObj(OWL_COMPLEMENT_OF);

  if (comp) return `complementOf ${renderTermCompact(comp)}`;
  if (inter && inter.termType === "BlankNode") {
    const items = readRdfList(inter.value).map(renderTermCompact);
    if (items.length) return `intersectionOf (${items.join(" AND ")})`;
  }
  if (uni && uni.termType === "BlankNode") {
    const items = readRdfList(uni.value).map(renderTermCompact);
    if (items.length) return `unionOf (${items.join(" OR ")})`;
  }

  return `[Blank node: ${quads.length} triple(s)]`;
}

function renderClassExpression(bnid) {
  // More verbose, multi-line view of a bnode restriction/expression
  const quads = state.blankNodes.get(bnid) ?? [];
  if (!quads.length) return "";

  // human readable lines
  const lines = [];
  for (const q of quads) {
    const p = q.predicate.termType === "NamedNode" ? iriToCurie(q.predicate.value) : termToString(q.predicate);
    const o = renderTermCompact(q.object);
    lines.push(`${p}  ${o}`);
  }
  return lines.sort().join("\n");
}

function renderTermCompact(term) {
  if (!term) return "";
  if (term.termType === "NamedNode") return displayName(term.value);
  if (term.termType === "BlankNode") {
    // include summary to help browsing
    const s = renderBlankNodeSummary(term.value);
    return "_:" + term.value + (s ? ` (${s})` : "");
  }
  if (term.termType === "Literal") {
    const lang = term.language ? `@${term.language}` : "";
    return `"${term.value}"${lang}`;
  }
  return termToString(term);
}

function readRdfList(headBnodeId) {
  // Reads rdf:List starting at _:head
  // Returns array of N3 terms (objects of rdf:first)
  const out = [];
  let current = headBnodeId;
  const seen = new Set();

  while (current && current !== RDF_NIL && !seen.has(current)) {
    seen.add(current);
    const quads = state.blankNodes.get(current) ?? [];
    const firstQ = quads.find(q => q.predicate.termType === "NamedNode" && q.predicate.value === RDF_FIRST);
    const restQ  = quads.find(q => q.predicate.termType === "NamedNode" && q.predicate.value === RDF_REST);

    if (!firstQ) break;
    out.push(firstQ.object);

    if (!restQ) break;

    if (restQ.object.termType === "NamedNode" && restQ.object.value === RDF_NIL) break;
    if (restQ.object.termType === "BlankNode") current = restQ.object.value;
    else break;
  }
  return out;
}

//////////////////////
// Bootstrapping UI
//////////////////////

function wireUi() {
  // Your index.html uses #searchBox; older code expected #searchInput.
  const search = $("#searchInput") || $("#searchBox");
  if (search) {
    search.addEventListener("input", () => renderEntityList());
  const loadBtn = $("#loadOntology");
  if (loadBtn) {
    loadBtn.addEventListener("click", () => {
      const sel = $("#ontologySelect");
      if (sel && sel.value) loadOntology(sel.value);
    });
  }
  }

  document.querySelectorAll('input[type="checkbox"][data-kind]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const kind = cb.getAttribute("data-kind");
      if (!kind) return;
      if (cb.checked) state.activeFilters.add(kind);
      else state.activeFilters.delete(kind);
      renderEntityList();
    });
  });
}

async function bootstrap() {
  try {
    if (typeof N3 === "undefined") {
      setStatus("N3.js did not load. Check the script tag in index.html.", true);
      return;
    }
    wireUi();
    await loadCatalog();
  } catch (err) {
    console.error(err);
    setStatus(String(err?.message ?? err), true);
    $("#details").innerHTML = `<div class="placeholder"><h2 class="bad">Error</h2><pre class="mono">${escapeHtml(String(err?.stack ?? err))}</pre></div>`;
  }
}

document.addEventListener("DOMContentLoaded", bootstrap);
