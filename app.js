let store = [];
let classes = [];
let labels = new Map();
let definitions = new Map();
let parents = new Map();
let children = new Map();

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
const RDFS_CLASS = "http://www.w3.org/2000/01/rdf-schema#Class";
const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const RDFS_SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const IAO_DEFINITION = "http://purl.obolibrary.org/obo/IAO_0000115";

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
}

function buildIndexes() {
  const classSet = new Set();

  for (const quad of store) {
    const subject = quad.subject.value;
    const predicate = quad.predicate.value;
    const object = quad.object.value;

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

    if (predicate === RDFS_SUBCLASS_OF) {
      if (!parents.has(subject)) {
        parents.set(subject, []);
      }

      parents.get(subject).push(object);

      if (!children.has(object)) {
        children.set(object, []);
      }

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
    return label.includes(query) || iri.toLowerCase().includes(query);
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

  const parentList = parents.get(iri) || [];
  const childList = children.get(iri) || [];

  details.innerHTML = "";

  const title = document.createElement("h3");
  title.textContent = getLabel(iri);
  details.appendChild(title);

  details.appendChild(makeField("IRI", iri));
  details.appendChild(makeField("Definition", definitions.get(iri) || "No definition available."));

  details.appendChild(makeList("Parents", parentList));
  details.appendChild(makeList("Children", childList));
}

function makeField(label, value) {
  const div = document.createElement("div");
  div.innerHTML = `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}`;
  return div;
}

function makeList(label, items) {
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
    for (const iri of items) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.textContent = getLabel(iri);
      button.addEventListener("click", () => renderDetails(iri));
      li.appendChild(button);
      ul.appendChild(li);
    }
  }

  section.appendChild(ul);
  return section;
}

function getLabel(iri) {
  return labels.get(iri) || compactIri(iri);
}

function compactIri(iri) {
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
