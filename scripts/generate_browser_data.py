"""
Generate ontology browser data for GitHub Pages.
Outputs docs/data/classes.json and docs/data/properties.json,
including ALL properties in the ontology, not just parent/child.
"""

from pathlib import Path
import json

from rdflib import Graph, RDF, RDFS, OWL, URIRef, Literal, BNode
from rdflib.namespace import SKOS

ONTOLOGY_FILES = [
    "ontology/clinops.ttl",
    "ontology/clinops.owl",
]

OUTPUT_DIR = Path("docs/data")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

IAO_DEFINITION = URIRef("http://purl.obolibrary.org/obo/IAO_0000115")
OBO_EXACT_SYN = URIRef("http://www.geneontology.org/formats/oboInOwl#hasExactSynonym")
OBO_RELATED_SYN = URIRef("http://www.geneontology.org/formats/oboInOwl#hasRelatedSynonym")
OBO_BROAD_SYN = URIRef("http://www.geneontology.org/formats/oboInOwl#hasBroadSynonym")
OBO_NARROW_SYN = URIRef("http://www.geneontology.org/formats/oboInOwl#hasNarrowSynonym")

g = Graph()

for path in ONTOLOGY_FILES:
    if Path(path).exists():
        g.parse(path)

def local_id(uri):
    text = str(uri)
    if "#" in text:
        return text.rsplit("#", 1)[1]
    return text.rstrip("/").rsplit("/", 1)[-1]

def label_of(uri):
    for value in g.objects(uri, RDFS.label):
        return str(value)
    return local_id(uri)

def literals(subject, predicate):
    return [str(value) for value in g.objects(subject, predicate) if isinstance(value, Literal)]

def references(subject, predicate):
    result = []
    for value in g.objects(subject, predicate):
        if isinstance(value, URIRef):
            result.append({
                "id": local_id(value),
                "iri": str(value),
                "label": label_of(value),
            })
    return result

def render_class_expression(node):
    """Render an OWL class expression (named class, restriction, or boolean) as text."""
    if isinstance(node, URIRef):
        return label_of(node)

    if isinstance(node, Literal):
        return str(node)

    if isinstance(node, BNode):
        # Restriction
        if (node, RDF.type, OWL.Restriction) in g:
            on_property = next(g.objects(node, OWL.onProperty), None)
            property_label = label_of(on_property) if on_property else "?"

            for filler in g.objects(node, OWL.someValuesFrom):
                return f"{property_label} some {render_class_expression(filler)}"
            for filler in g.objects(node, OWL.allValuesFrom):
                return f"{property_label} only {render_class_expression(filler)}"
            for filler in g.objects(node, OWL.hasValue):
                return f"{property_label} value {render_class_expression(filler)}"
            for filler in g.objects(node, OWL.minCardinality):
                return f"{property_label} min {filler}"
            for filler in g.objects(node, OWL.maxCardinality):
                return f"{property_label} max {filler}"
            for filler in g.objects(node, OWL.cardinality):
                return f"{property_label} exactly {filler}"

        # Boolean combinations
        for combinator, keyword in [
            (OWL.intersectionOf, "and"),
            (OWL.unionOf, "or"),
        ]:
            head = next(g.objects(node, combinator), None)
            if head is not None:
                parts = [render_class_expression(item) for item in rdf_list(head)]
                return f" {keyword} ".join(parts)

        head = next(g.objects(node, OWL.complementOf), None)
        if head is not None:
            return f"not ({render_class_expression(head)})"

    return "?"

def rdf_list(head):
    items = []
    while head and head != RDF.nil:
        first = next(g.objects(head, RDF.first), None)
        if first is not None:
            items.append(first)
        head = next(g.objects(head, RDF.rest), None)
    return items

def annotations_of(subject):
    """Collect every annotation property value attached to subject."""
    annotations = {}
    skip_predicates = {
        RDFS.subClassOf,
        RDFS.subPropertyOf,
        RDF.type,
        OWL.equivalentClass,
        OWL.equivalentProperty,
        OWL.disjointWith,
        OWL.inverseOf,
        RDFS.domain,
        RDFS.range,
    }

    for predicate, value in g.predicate_objects(subject):
        if predicate in skip_predicates:
            continue

        key = label_of(predicate) if isinstance(predicate, URIRef) else str(predicate)

        if isinstance(value, Literal):
            text = str(value)
        elif isinstance(value, URIRef):
            text = label_of(value)
        else:
            text = render_class_expression(value)

        annotations.setdefault(key, []).append(text)

    return annotations

def extract_class(cls):
    parents_named = []
    restrictions = []

    for superclass in g.objects(cls, RDFS.subClassOf):
        if isinstance(superclass, URIRef):
            parents_named.append({
                "id": local_id(superclass),
                "iri": str(superclass),
                "label": label_of(superclass),
            })
        else:
            restrictions.append(render_class_expression(superclass))

    children = []
    for child in g.subjects(RDFS.subClassOf, cls):
        if isinstance(child, URIRef):
            children.append({
                "id": local_id(child),
                "iri": str(child),
                "label": label_of(child),
            })

    equivalents = []
    for equivalent in g.objects(cls, OWL.equivalentClass):
        equivalents.append(render_class_expression(equivalent))

    disjoints = references(cls, OWL.disjointWith)

    # Properties whose domain includes this class
    property_usage = []
    for prop in g.subjects(RDFS.domain, cls):
        if isinstance(prop, URIRef):
            ranges = references(prop, RDFS.range)
            property_usage.append({
                "id": local_id(prop),
                "iri": str(prop),
                "label": label_of(prop),
                "ranges": ranges,
            })

    definitions = literals(cls, SKOS.definition) + literals(cls, IAO_DEFINITION) + literals(cls, RDFS.comment)

    synonyms = (
        literals(cls, SKOS.altLabel)
        + literals(cls, OBO_EXACT_SYN)
        + literals(cls, OBO_RELATED_SYN)
        + literals(cls, OBO_BROAD_SYN)
        + literals(cls, OBO_NARROW_SYN)
    )

    return {
        "id": local_id(cls),
        "iri": str(cls),
        "label": label_of(cls),
        "definition": definitions[0] if definitions else "",
        "synonyms": synonyms,
        "parents": parents_named,
        "children": children,
        "equivalentClasses": equivalents,
        "disjointWith": disjoints,
        "restrictions": restrictions,
        "propertyUsage": property_usage,
        "annotations": annotations_of(cls),
        "deprecated": bool(list(g.objects(cls, OWL.deprecated))),
    }

def extract_property(prop, property_type):
    return {
        "id": local_id(prop),
        "iri": str(prop),
        "label": label_of(prop),
        "type": property_type,
        "domain": references(prop, RDFS.domain),
        "range": references(prop, RDFS.range),
        "parents": references(prop, RDFS.subPropertyOf),
        "children": [
            {
                "id": local_id(child),
                "iri": str(child),
                "label": label_of(child),
            }
            for child in g.subjects(RDFS.subPropertyOf, prop)
            if isinstance(child, URIRef)
        ],
        "inverseOf": references(prop, OWL.inverseOf),
        "equivalent": references(prop, OWL.equivalentProperty),
        "annotations": annotations_of(prop),
        "deprecated": bool(list(g.objects(prop, OWL.deprecated))),
    }

classes = [
    extract_class(cls)
    for cls in g.subjects(RDF.type, OWL.Class)
    if isinstance(cls, URIRef)
]

properties = []
for rdf_type, kind in [
    (OWL.ObjectProperty, "objectProperty"),
    (OWL.DatatypeProperty, "dataProperty"),
    (OWL.AnnotationProperty, "annotationProperty"),
    (RDF.Property, "rdfProperty"),
]:
    for prop in g.subjects(RDF.type, rdf_type):
        if isinstance(prop, URIRef):
            properties.append(extract_property(prop, kind))

classes.sort(key=lambda item: item["label"].lower())
properties.sort(key=lambda item: item["label"].lower())

(OUTPUT_DIR / "classes.json").write_text(json.dumps(classes, indent=2, ensure_ascii=False), encoding="utf-8")
(OUTPUT_DIR / "properties.json").write_text(json.dumps(properties, indent=2, ensure_ascii=False), encoding="utf-8")

print(f"Wrote {len(classes)} classes and {len(properties)} properties.")
