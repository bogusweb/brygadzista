// Parameters read from the PDF text by rules, without a model (#53): a value with its unit and the words naming it,
// e.g. "styrodurem gr. 10 cm" → { label: "styrodurem", value: "10", unit: "cm" }. Search matches questions against the
// labels, and the matching parameters come with each result, so the agent sees the number without reading the page.

export type Fact = { label: string; value: string; unit: string; quote: string };

// Bump when extraction changes: pages with an older version get their facts again from stored text at startup.
export const FACTS_VERSION = 1;

const MAX_FACTS_PER_PAGE = 200;
const LABEL_WORDS = 6;
const LABEL_LOOKBACK = 90;
const QUOTE_CONTEXT = 60;

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
// Longest first, so "m2" is not read as "m" and "kN/m2" not as "kN".
const UNITS = [
  "W/\\(m2\\*?K\\)", "W/m2\\*?K", "W/m²K", "W/\\(m\\*?K\\)", "W/m\\*?K", "kN/m2", "kN/m²", "kg/m3", "kg/m³", "kN/m", "MPa",
  "kN", "kg", "mm", "cm", "m2", "m²", "m3", "m³", "m", "%", "°", "szt\\.?",
];
const VALUE = new RegExp(
  String.raw`(Ø\s*)?(${NUMBER}(?:\s*[x×]\s*${NUMBER}){0,2})\s*(${UNITS.join("|")})(?![\p{L}\d])`,
  "gu",
);
// Classes without a unit: concrete (C25/30), steel (B500SP), insulation boards (EPS 100-038), fire resistance (REI 60).
const CLASS = /\b(C\d{1,2}\/\d{2}|LC\d{1,2}\/\d{2}|B\d{3}[A-Z]{0,2}|EPS\s?\d{2,3}(?:-\d{3})?|REI\s?\d{2,3}|EI\s?\d{2,3})\b/gu;

// Words between a parameter's name and its value that name nothing: "styropian gr. 15 cm", "pod kątem 24°".
const FILLERS = new Set([
  "gr", "gr.", "grub.", "o", "min", "min.", "max", "max.", "ok", "ok.", "około", "co", "na", "wg", "do", "od", "w", "z", "i", "=",
  "–", "-", ":", "oraz", "lub", "albo", "wynosi", "wynoszącej", "pod", "kątem", "≥", "≤", ">", "<", "ca", "rzędu",
]);

const LIST_JOINER = /^\s*(?:i|oraz|lub|albo|,|\/)\s*$/u;

const collapse = (text: string) => text.replace(/\u00ad/g, "").replace(/-\n(?=\p{Ll})/gu, "").replace(/\s+/g, " ");

// The words naming a value: the end of the clause before it (never reaching back past the previous value), without
// filler words at its ends.
const labelBefore = (text: string, at: number, from = 0) => {
  const before = text.slice(Math.max(from, at - LABEL_LOOKBACK), at);
  const clause = before.split(/[,;()]|\.\s+(?=\p{Lu})|\s-\s(?=\p{Ll})|^\s*-\s/u).at(-1) ?? "";
  const words = clause.split(" ").filter(Boolean);
  while (words.length && FILLERS.has(words.at(-1)!.toLowerCase())) words.pop();
  while (words.length && FILLERS.has(words[0]!.toLowerCase())) words.shift();
  return words.slice(-LABEL_WORDS).join(" ").replace(/[=:–]+$/u, "").trim();
};

const quoteAround = (text: string, from: number, to: number) =>
  text.slice(Math.max(0, from - QUOTE_CONTEXT), Math.min(text.length, to + QUOTE_CONTEXT)).trim();

export const extractFacts = (raw: string): Fact[] => {
  const text = collapse(raw);
  const facts: Fact[] = [];
  const seen = new Set<string>();
  const add = (fact: Fact) => {
    const key = `${fact.label.toLowerCase()}|${fact.value}|${fact.unit}`;
    if (!fact.label || seen.has(key) || facts.length >= MAX_FACTS_PER_PAGE) return;
    seen.add(key);
    facts.push(fact);
  };
  // "grubości 15 cm i 5 cm", "Ø120mm i Ø90mm": a value listed right after another one shares its label.
  let previous = { end: 0, label: "" };
  for (const match of text.matchAll(VALUE)) {
    const value = `${match[1] ? "Ø" : ""}${match[2]!.replace(/\s+/g, "").replace("×", "x")}`;
    const listed = previous.label && LIST_JOINER.test(text.slice(previous.end, match.index));
    const label = listed ? previous.label : labelBefore(text, match.index, previous.end);
    previous = { end: match.index + match[0].length, label };
    add({
      label,
      value,
      unit: match[3]!.replace(/\.$/, ""),
      quote: quoteAround(text, match.index, match.index + match[0].length),
    });
  }
  for (const match of text.matchAll(CLASS)) {
    add({
      label: labelBefore(text, match.index) || match[1]!,
      value: match[1]!.replace(/\s/g, " "),
      unit: "",
      quote: quoteAround(text, match.index, match.index + match[0].length),
    });
  }
  return facts;
};

export const formatFact = (fact: { value: string; unit: string }) => (fact.unit ? `${fact.value} ${fact.unit}` : fact.value);
