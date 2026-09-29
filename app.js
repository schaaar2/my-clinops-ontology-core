let store = [];
let classes = [];
let labels = new Map();
let definitions = new Map();
let parents = new Map();
let children = new Map();

// New indexes for richer browsing
let outgoing = new Map();      // subject IRI  -> [{ predicate, object, isLiteral, isBlank, datatype, language }]
let incoming = new Map();      // object IRI   -> [{ predicate, subject }]
let blankNodes = new Map();    // blank node id -> [{ predicate, object, isLiteral, isBlank, datatype, language }]

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
const RDFS_CLASS = "http://www.w3.org/2000/01/rdf-schema#Class";
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const RDFS_SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const IAO_DEFINITION = "http://purl.obolibrary.org/obo/IAO_0000115";

// OWL restriction vocabulary
const OWL_ON_PROPERTY       = "http://www.w3.org/2002/07/owl#onProperty";
const OWL_SOME_VALUES_FROM  = "http://www.w3.org/2002/07/owl#someValuesFrom";
const OWL_ALL_VALUES_FROM   = "http://www.w3.org/2002/07/owl#allValuesFrom";
const OWL_HAS_VALUE         = "http://www.w3.org/2002/07/owl#hasValue";
const OWL_MIN_CARDINALITY   = "http://www.w3.org/2002/07/owl#minCardinality";
const OWL_MAX_CARDINALITY   = "http://www.w3.org/2002/07/owl#maxCardinality";
const OWL_CARDINALITY       = "http://www.w3.org/2002/07/owl#cardinality";
const OWL_INTERSECTION_OF   = "http://www.w3.org/2002/07/owl#intersectionOf";
const OWL_UNION_OF          = "http://www.w3.org/2002/07/owl#unionOf";
const OWL_COMPLEMENT_OF     = "http://www.w3.org/2002/07/owl#complementOf";
const RDF_FIRST             = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
const RDF_REST              = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
const RDF_NIL               = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";

// Predicates that are rendered in their own dedicated sections
const HANDLED_PREDICATES = new Set([
  RDF_TYPE,
  RDFS_LABEL,
  RDFS_SUBCLASS_OF,
  IAO_DEFINITION,
]);

document.addEventListener("DOMContentLoaded", async () => {
  await loadCatalog();

  document.getElementById("loadOntology").addEventListener("click", async () => {
    const file = document.getElementById("ontologySelect").value;
    await loadOntology(file);
  });

  document.getElementById("searchBox").addEventListener("input", event => {
    renderClassList(event.target.value);
  });
});

async function loadCatalog() {
  const response = await fetch("ontologies/catalog.json");
  const catalog = await response.json();

  const select = document.getElementById("ontologySelect");

  for (const ontology of catalog) {
    const option = document.createElement("option");
    option.value = ontology.file;
    option.textContent = ontology.title;
    select.appendChild(option);
  }
}

async function loadOntology(file) {
  resetData();

  const response = await fetch(file);
  const ttl = await response.text();

  const parser = new N3.Parser();
  store = parser.parse(ttl);

  buildIndexes();
  renderClassList("");
}

function resetData() {
  store = [];
  classes = [];
  labels = new Map();
  definitions = new Map();
  parents = new Map();
  children = new Map();
  outgoing = new Map();
  incoming = new Map();
  blankNodes = new Map();
}

function buildIndexes() {
  const classSet = new Set();

  for (const quad of store) {
    const subject = quad.subject.value;
    const predicate = quad.predicate.value;
    const object = quad.object.value;
    const subjectIsBlank = quad.subject.termType === "BlankNode";
    const objectIsLiteral = quad.object.termType === "Literal";
    const objectIsBlank = quad.object.termType === "BlankNode";

    const record = {
      predicate,
      object,
      isLiteral: objectIsLiteral,
      isBlank: objectIsBlank,
      datatype: objectIsLiteral && quad.object.datatype ? quad.object.datatype.value : null,
      language: objectIsLiteral ? quad.object.language : null,
    };

    if (subjectIsBlank) {
      if (!blankNodes.has(subject)) blankNodes.set(subject, []);
      blankNodes.get(subject).push(record);
    } else {
      if (!outgoing.has(subject)) outgoing.set(subject, []);
      outgoing.get(subject).push(record);
    }

    if (!objectIsLiteral && !objectIsBlank) {
      if (!incoming.has(object)) incoming.set(object, []);
      incoming.get(object).push({ predicate, subject });
    }

    if (
      predicate === RDF_TYPE &&
      (object === OWL_CLASS || object === RDFS_CLASS)
    ) {
      classSet.add(subject);
    }

    if (predicate === RDFS_LABEL) {
      labels.set(subject, object);
    }

    if (predicate === IAO_DEFINITION) {
      definitions.set(subject, object);
    }

    if (predicate === RDFS_SUBCLASS_OF && !objectIsBlank) {
      if (!parents.has(subject)) parents.set(subject, []);
      parents.get(subject).push(object);

      if (!children.has(object)) children.set(object, []);
      children.get(object).push(subject);
    }
  }

  classes = Array.from(classSet).sort((a, b) => {
    const labelA = getLabel(a).toLowerCase();
    const labelB = getLabel(b).toLowerCase();
    return labelA.localeCompare(labelB);
  });
}
function renderClassList(filter) {
  const list = document.getElementById("classList");
  list.innerHTML = "";

  const query = filter.toLowerCase();

  const filteredClasses = classes.filter(iri => {
    const label = getLabel(iri).toLowerCase();
    const definition = (definitions.get(iri) || "").toLowerCase();
    return (
      label.includes(query) ||
      iri.toLowerCase().includes(query) ||
      definition.includes(query)
    );
  });

  for (const iri of filteredClasses) {
    const item = document.createElement("li");
    const button = document.createElement("button");

    button.textContent = getLabel(iri);
    button.addEventListener("click", () => renderDetails(iri));

    item.appendChild(button);
    list.appendChild(item);
  }
}

function renderDetails(iri) {
  const details = document.getElementById("details");
  details.innerHTML = "";

  const title = document.createElement("h3");
  title.textContent = getLabel(iri);
  details.appendChild(title);

  details.appendChild(makeField("IRI", iri));
  details.appendChild(makeField("Definition", definitions.get(iri) || "No definition available."));

  // Parents / Children
  details.appendChild(makeIriList("Parents", parents.get(iri) || []));
  details.appendChild(makeIriList("Children", children.get(iri) || []));

  // Types (rdf:type values other than owl:Class)
  const types = (outgoing.get(iri) || [])
    .filter(record => record.predicate === RDF_TYPE)
    .map(record => record.object);
  if (types.length > 0) {
    details.appendChild(makeIriList("Types", types));
  }

  // Restrictions and anonymous superclasses (subClassOf pointing to a blank node)
  const restrictions = (outgoing.get(iri) || [])
    .filter(record => record.predicate === RDFS_SUBCLASS_OF && record.isBlank)
    .map(record => renderClassExpression(record.object));
  if (restrictions.length > 0) {
    details.appendChild(makeTextList("Restrictions and anonymous superclasses", restrictions));
  }

  // Every other outgoing predicate, grouped by predicate IRI
  const otherOutgoing = groupByPredicate(
    (outgoing.get(iri) || []).filter(record =>
      !HANDLED_PREDICATES.has(record.predicate) &&
      record.predicate !== RDFS_SUBCLASS_OF
    )
  );

  if (otherOutgoing.size > 0) {
    const heading = document.createElement("h4");
    heading.textContent = "All properties on this entity";
    details.appendChild(heading);

    for (const [predicate, records] of otherOutgoing) {
      details.appendChild(makePredicateBlock(predicate, records));
    }
  }

  // Incoming references (which other terms mention this one, and how)
  const incomingRefs = (incoming.get(iri) || []).filter(
    ref => ref.predicate !== RDFS_SUBCLASS_OF
  );

  if (incomingRefs.length > 0) {
    const heading = document.createElement("h4");
    heading.textContent = "Referenced by";
    details.appendChild(heading);

    const grouped = new Map();
    for (const ref of incomingRefs) {
      if (!grouped.has(ref.predicate)) grouped.set(ref.predicate, []);
      grouped.get(ref.predicate).push(ref.subject);
    }

    for (const [predicate, subjects] of grouped) {
      const block = document.createElement("div");
      block.className = "predicate-block";

      const label = document.createElement("strong");
      label.textContent = getLabel(predicate);
      label.title = predicate;
      block.appendChild(label);

      const ul = document.createElement("ul");
      for (const subject of subjects) {
        const li = document.createElement("li");
        li.appendChild(makeIriLink(subject));
        ul.appendChild(li);
      }
      block.appendChild(ul);

      details.appendChild(block);
    }
  }
}
function groupByPredicate(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.predicate)) grouped.set(record.predicate, []);
    grouped.get(record.predicate).push(record);
  }
  return grouped;
}

function makePredicateBlock(predicate, records) {
  const block = document.createElement("div");
  block.className = "predicate-block";

  const label = document.createElement("strong");
  label.textContent = getLabel(predicate);
  label.title = predicate;
  block.appendChild(label);

  const ul = document.createElement("ul");
  for (const record of records) {
    const li = document.createElement("li");
    li.appendChild(renderValue(record));
    ul.appendChild(li);
  }
  block.appendChild(ul);

  return block;
}

function renderValue(record) {
  if (record.isLiteral) {
    const span = document.createElement("span");
    let text = record.object;
    if (record.language) {
      text += ` @${record.language}`;
    } else if (
      record.datatype &&
      record.datatype !== "http://www.w3.org/2001/XMLSchema#string" &&
      record.datatype !== "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
    ) {
      text += ` (${compactIri(record.datatype)})`;
    }
    span.textContent = text;
    return span;
  }

  if (record.isBlank) {
    const span = document.createElement("span");
    span.textContent = renderClassExpression(record.object);
    return span;
  }

  return makeIriLink(record.object);
}

function renderClassExpression(nodeId, depth = 0) {
  if (depth > 6) return "…";

  const records = blankNodes.get(nodeId) || [];
  if (records.length === 0) return "_:" + nodeId;

  const get = (predicate) =>
    records.filter(record => record.predicate === predicate);

  // OWL restriction
  const onProperty = get(OWL_ON_PROPERTY)[0];
  if (onProperty) {
    const propertyLabel = onProperty.isBlank ? "?" : getLabel(onProperty.object);

    const some = get(OWL_SOME_VALUES_FROM)[0];
    if (some) return `${propertyLabel} some ${renderFiller(some, depth)}`;

    const only = get(OWL_ALL_VALUES_FROM)[0];
    if (only) return `${propertyLabel} only ${renderFiller(only, depth)}`;

    const value = get(OWL_HAS_VALUE)[0];
    if (value) return `${propertyLabel} value ${renderFiller(value, depth)}`;

    const minCard = get(OWL_MIN_CARDINALITY)[0];
    if (minCard) return `${propertyLabel} min ${minCard.object}`;

    const maxCard = get(OWL_MAX_CARDINALITY)[0];
    if (maxCard) return `${propertyLabel} max ${maxCard.object}`;

    const exact = get(OWL_CARDINALITY)[0];
    if (exact) return `${propertyLabel} exactly ${exact.object}`;

    return `${propertyLabel} …`;
  }

  // Boolean combinations
  const intersection = get(OWL_INTERSECTION_OF)[0];
  if (intersection) {
    const items = readList(intersection.object).map(item => renderFillerId(item, depth));
    return items.join(" and ");
  }

  const union = get(OWL_UNION_OF)[0];
  if (union) {
    const items = readList(union.object).map(item => renderFillerId(item, depth));
    return "(" + items.join(" or ") + ")";
  }

  const complement = get(OWL_COMPLEMENT_OF)[0];
  if (complement) {
    return "not (" + renderFiller(complement, depth) + ")";
  }

  // Fallback: show the predicates present on this blank node
  return records
    .map(record => {
      const objectText = record.isBlank
        ? renderClassExpression(record.object, depth + 1)
        : getLabel(record.object);
      return `${getLabel(record.predicate)} ${objectText}`;
    })
    .join(" ; ");
}

function renderFiller(record, depth) {
  if (record.isLiteral) return record.object;
  if (record.isBlank) return "(" + renderClassExpression(record.object, depth + 1) + ")";
  return getLabel(record.object);
}

function renderFillerId(nodeIdOrIri, depth) {
  if (blankNodes.has(nodeIdOrIri)) {
    return "(" + renderClassExpression(nodeIdOrIri, depth + 1) + ")";
  }
  return getLabel(nodeIdOrIri);
}

function readList(headId) {
  const items = [];
  let current = headId;
  let guard = 0;

  while (current && current !== RDF_NIL && guard++ < 1000) {
    const records = blankNodes.get(current) || [];
    const first = records.find(record => record.predicate === RDF_FIRST);
    const rest = records.find(record => record.predicate === RDF_REST);
    if (first) items.push(first.object);
    current = rest ? rest.object : null;
  }

  return items;
}

function makeField(label, value) {
  const div = document.createElement("div");
  div.innerHTML = `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}`;
  return div;
}

function makeIriList(label, iris) {
  const section = document.createElement("div");

  const heading = document.createElement("h4");
  heading.textContent = label;
  section.appendChild(heading);

  const ul = document.createElement("ul");

  if (iris.length === 0) {
    const li = document.createElement("li");
    li.textContent = "None";
    ul.appendChild(li);
  } else {
    for (const iri of iris) {
      const li = document.createElement("li");
      li.appendChild(makeIriLink(iri));
      ul.appendChild(li);
    }
  }

  section.appendChild(ul);
  return section;
}

function makeTextList(label, items) {
  const section = document.createElement("div");

  const heading = document.createElement("h4");
  heading.textContent = label;
  section.appendChild(heading);

  const ul = document.createElement("ul");

  if (items.length === 0) {
    const li = document.createElement("li");
    li.textContent = "None";
    ul.appendChild(li);
  } else {
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    }
  }

  section.appendChild(ul);
  return section;
}

function makeIriLink(iri) {
  const button = document.createElement("button");
  button.textContent = getLabel(iri);
  button.title = iri;
  button.addEventListener("click", () => renderDetails(iri));
  return button;
}

function getLabel(iri) {
  return labels.get(iri) || compactIri(iri);
}

function compactIri(iri) {
  if (!iri) return "";
  if (iri.includes("#")) {
    return iri.split("#").pop();
  }
  return iri.split("/").pop();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
