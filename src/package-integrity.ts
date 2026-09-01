import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";

export const packageIntegrityCodes = [
  "PACKAGE_ZIP_INVALID",
  "PACKAGE_CORE_PART_MISSING",
  "PACKAGE_XML_INVALID",
  "PACKAGE_RELATIONSHIP_ID_DUPLICATE",
  "PACKAGE_RELATIONSHIP_TARGET_MISSING",
  "PACKAGE_RELATIONSHIP_REFERENCE_MISSING",
  "PACKAGE_DRAWING_ID_DUPLICATE",
  "PACKAGE_SLIDE_ID_DUPLICATE",
  "PACKAGE_CONTENT_TYPE_MISSING",
  "PACKAGE_CHART_INVALID",
  "PLACEHOLDER_CONTENT_LEAK",
] as const;

export type PackageIntegrityCode = (typeof packageIntegrityCodes)[number];
export type PackageIntegrityFinding = {
  severity: "hard";
  code: PackageIntegrityCode;
  part?: string;
  message: string;
  signature: string;
  inherited?: boolean;
};
export type PackageIntegrityReport = {
  status: "pass" | "fail";
  findings: PackageIntegrityFinding[];
  baselineFindings: PackageIntegrityFinding[];
  newFindings: PackageIntegrityFinding[];
};

const PLACEHOLDER_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "lorem", pattern: /\blorem\b/i },
  { id: "ipsum", pattern: /\bipsum\b/i },
  { id: "todo", pattern: /^\s*todo(?:\b|:)/i },
  { id: "xxxx", pattern: /\bxxxx+\b/i },
  { id: "insert", pattern: /\[\s*insert\b/i },
  { id: "layout-copy", pattern: /\bthis page layout\b/i },
  { id: "subtitle", pattern: /^\s*subtitle\s*$/i },
  { id: "recipient", pattern: /^\s*recipient\s*$/i },
  { id: "date-company", pattern: /^\s*date\s*[·|\-]\s*company\s*$/i },
];

function parseXml(xml: string): Document | undefined {
  let failed = false;
  const document = new DOMParser({
    onError: (level) => {
      if (level !== "warning") failed = true;
    },
  }).parseFromString(xml, "text/xml");
  return failed || !document?.documentElement ? undefined : (document as unknown as Document);
}

function elements(scope: Document | Element, namespace: string, localName: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS(namespace, localName));
}

function relationshipSource(relPath: string): string | undefined {
  if (relPath === "_rels/.rels") return "";
  const match = relPath.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
  return match ? path.posix.join(match[1], match[2]) : undefined;
}

function packagePath(sourcePart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = sourcePart ? path.posix.dirname(sourcePart) : "";
  return path.posix.normalize(path.posix.join(base, target));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function finding(code: PackageIntegrityCode, message: string, part?: string, signatureDetail?: string): PackageIntegrityFinding {
  const stableDetail = signatureDetail ?? normalizeText(message);
  return { severity: "hard", code, ...(part ? { part } : {}), message, signature: `${code}|${part ?? ""}|${stableDetail}` };
}

function placeholderFinding(text: string, patternId: string, part: string): PackageIntegrityFinding {
  // Placeholder baselines deliberately ignore the physical slide part. Automizer may renumber a
  // template-derived slide while preserving the exact inherited placeholder text.
  const normalized = normalizeText(text).toLowerCase();
  return { severity: "hard", code: "PLACEHOLDER_CONTENT_LEAK", part, message: `Placeholder-like content remains in ${part}: '${normalizeText(text)}'.`, signature: `PLACEHOLDER_CONTENT_LEAK|${patternId}|${normalized}` };
}

function relationshipIdsUsed(document: Document): Set<string> {
  const ids = new Set<string>();
  const visit = (node: Element): void => {
    for (let index = 0; index < node.attributes.length; index += 1) {
      const attribute = node.attributes.item(index);
      if (attribute?.namespaceURI === R_NS && attribute.value) ids.add(attribute.value);
    }
    for (const child of Array.from(node.childNodes)) if (child.nodeType === 1) visit(child as Element);
  };
  visit(document.documentElement as unknown as Element);
  return ids;
}

async function inspectPackage(pptxPath: string): Promise<PackageIntegrityFinding[]> {
  const findings: PackageIntegrityFinding[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(path.resolve(pptxPath)));
  } catch {
    return [finding("PACKAGE_ZIP_INVALID", `PPTX is not a readable ZIP package: ${pptxPath}`)];
  }

  const required = ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"];
  for (const part of required) if (!zip.file(part)) findings.push(finding("PACKAGE_CORE_PART_MISSING", `Required package part is missing: ${part}`, part, part));

  const xmlDocuments = new Map<string, Document>();
  const xmlNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir && (name.endsWith(".xml") || name.endsWith(".rels")));
  for (const name of xmlNames) {
    const xml = await zip.file(name)?.async("string");
    const document = xml === undefined ? undefined : parseXml(xml);
    if (!document) {
      findings.push(finding("PACKAGE_XML_INVALID", `XML is not well formed: ${name}`, name, name));
      continue;
    }
    xmlDocuments.set(name, document);
  }

  for (const relPath of xmlNames.filter((name) => name.endsWith(".rels"))) {
    const document = xmlDocuments.get(relPath);
    const source = relationshipSource(relPath);
    if (!document || source === undefined) continue;
    const relationships = elements(document, REL_NS, "Relationship");
    const ids = relationships.map((item) => item.getAttribute("Id") ?? "").filter(Boolean);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    for (const id of duplicates) findings.push(finding("PACKAGE_RELATIONSHIP_ID_DUPLICATE", `Duplicate relationship id '${id}' in ${relPath}.`, relPath, id));
    for (const relationship of relationships) {
      if (relationship.getAttribute("TargetMode") === "External") continue;
      const target = relationship.getAttribute("Target") ?? "";
      if (!target) continue;
      const targetPart = packagePath(source, target);
      if (!zip.file(targetPart)) findings.push(finding("PACKAGE_RELATIONSHIP_TARGET_MISSING", `${source || "package"} relationship '${relationship.getAttribute("Id") ?? ""}' targets missing '${targetPart}'.`, source || relPath, `${relationship.getAttribute("Type") ?? ""}|${targetPart}`));
    }
  }

  for (const [part, document] of xmlDocuments) {
    if (part.endsWith(".rels") || part === "[Content_Types].xml") continue;
    const relPath = part ? path.posix.join(path.posix.dirname(part), "_rels", `${path.posix.basename(part)}.rels`) : "_rels/.rels";
    const relDocument = xmlDocuments.get(relPath);
    const defined = new Set(relDocument ? elements(relDocument, REL_NS, "Relationship").map((item) => item.getAttribute("Id") ?? "") : []);
    for (const id of relationshipIdsUsed(document)) if (!defined.has(id)) findings.push(finding("PACKAGE_RELATIONSHIP_REFERENCE_MISSING", `${part} references undefined relationship '${id}'.`, part, id));

    if (/^ppt\/(?:slides|slideLayouts|slideMasters)\/.+\.xml$/.test(part)) {
      const drawingIds = elements(document, P_NS, "cNvPr").map((node) => node.getAttribute("id") ?? "").filter(Boolean);
      const duplicates = [...new Set(drawingIds.filter((id, index) => drawingIds.indexOf(id) !== index))];
      for (const id of duplicates) findings.push(finding("PACKAGE_DRAWING_ID_DUPLICATE", `Duplicate non-visual drawing id '${id}' in ${part}.`, part, id));
    }

    if (/^ppt\/charts\/chart\d+\.xml$/.test(part) && elements(document, C_NS, "chartSpace").length !== 1) {
      findings.push(finding("PACKAGE_CHART_INVALID", `Chart part does not contain exactly one c:chartSpace: ${part}`, part, "chartSpace"));
    }

    if (/^ppt\/(?:slides|slideLayouts|slideMasters)\/.+\.xml$/.test(part)) {
      for (const textNode of elements(document, A_NS, "t")) {
        const text = textNode.textContent ?? "";
        const matched = PLACEHOLDER_PATTERNS.find(({ pattern }) => pattern.test(text));
        if (matched) findings.push(placeholderFinding(text, matched.id, part));
      }
    }
  }

  const presentation = xmlDocuments.get("ppt/presentation.xml");
  if (presentation) {
    const slideIds = elements(presentation, P_NS, "sldId").map((node) => node.getAttribute("id") ?? "").filter(Boolean);
    const duplicates = [...new Set(slideIds.filter((id, index) => slideIds.indexOf(id) !== index))];
    for (const id of duplicates) findings.push(finding("PACKAGE_SLIDE_ID_DUPLICATE", `Duplicate presentation slide id '${id}'.`, "ppt/presentation.xml", id));
  }

  const contentTypes = xmlDocuments.get("[Content_Types].xml");
  if (contentTypes) {
    const defaults = new Set(elements(contentTypes, CT_NS, "Default").map((item) => (item.getAttribute("Extension") ?? "").toLowerCase()));
    const overrides = new Set(elements(contentTypes, CT_NS, "Override").map((item) => (item.getAttribute("PartName") ?? "").replace(/^\//, "")));
    for (const name of Object.keys(zip.files).filter((item) => !zip.files[item].dir && item !== "[Content_Types].xml")) {
      const extension = path.posix.extname(name).slice(1).toLowerCase();
      if (!overrides.has(name) && (!extension || !defaults.has(extension))) findings.push(finding("PACKAGE_CONTENT_TYPE_MISSING", `No content type declaration covers ${name}.`, name, extension || name));
    }
  }

  return findings.sort((left, right) => left.signature.localeCompare(right.signature));
}

export async function validatePptxPackage(pptxPath: string, options: { originalPath?: string } = {}): Promise<PackageIntegrityReport> {
  const findings = await inspectPackage(pptxPath);
  const baselineFindings = options.originalPath ? await inspectPackage(options.originalPath) : [];
  const baseline = new Set(baselineFindings.map((item) => item.signature));
  const annotated = findings.map((item) => baseline.has(item.signature) ? { ...item, inherited: true } : item);
  const newFindings = annotated.filter((item) => !item.inherited);
  return { status: newFindings.length === 0 ? "pass" : "fail", findings: annotated, baselineFindings, newFindings };
}

export async function assertPptxPackageIntegrity(pptxPath: string, originalPath?: string): Promise<PackageIntegrityReport> {
  const report = await validatePptxPackage(pptxPath, { originalPath });
  if (report.status !== "pass") throw new Error(`PACKAGE_INTEGRITY_FAILED: ${report.newFindings.map((item) => `${item.code}${item.part ? `@${item.part}` : ""}`).join(", ")}`);
  return report;
}
