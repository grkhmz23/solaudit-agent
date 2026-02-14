/**
 * Robust JSON parsing for LLM responses.
 *
 * Strategies (tried in order):
 * 1. Strict JSON.parse
 * 2. Extract largest JSON object/array from mixed text
 * 3. Conservative repair (close braces/quotes, strip trailing commas)
 * 4. Return null (caller handles fallback)
 */

/**
 * Try to parse a JSON response from LLM output.
 * Returns parsed object or null.
 */
export function safeParseJSON<T = unknown>(raw: string): T | null {
  if (!raw || !raw.trim()) return null;

  // 1. Strip markdown code fences
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // 2. Try strict parse
  try {
    return JSON.parse(text) as T;
  } catch {
    // continue
  }

  // 3. Extract largest JSON block
  const extracted = extractLargestJSON(text);
  if (extracted) {
    try {
      return JSON.parse(extracted) as T;
    } catch {
      // continue
    }
  }

  // 4. Conservative repair
  const repaired = repairJSON(extracted || text);
  if (repaired) {
    try {
      return JSON.parse(repaired) as T;
    } catch {
      // give up
    }
  }

  return null;
}

/**
 * Extract the largest JSON object or array from a string.
 */
function extractLargestJSON(text: string): string | null {
  let best: string | null = null;
  let bestLen = 0;

  // Try to find balanced {} blocks
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      const closer = text[i] === "{" ? "}" : "]";
      let depth = 0;
      let inStr = false;
      let escape = false;
      let j = i;

      for (; j < text.length; j++) {
        if (escape) { escape = false; continue; }
        if (text[j] === "\\") { escape = true; continue; }
        if (text[j] === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (text[j] === text[i]) depth++;
        if (text[j] === closer) {
          depth--;
          if (depth === 0) {
            const candidate = text.slice(i, j + 1);
            if (candidate.length > bestLen) {
              best = candidate;
              bestLen = candidate.length;
            }
            break;
          }
        }
      }
    }
  }

  return best;
}

/**
 * Conservative JSON repair:
 * - Strip trailing commas before } or ]
 * - Close unclosed braces/brackets
 * - Close unclosed strings
 */
function repairJSON(text: string): string | null {
  if (!text) return null;

  let s = text;

  // Strip trailing commas
  s = s.replace(/,\s*([\]}])/g, "$1");

  // Count braces/brackets
  let braces = 0;
  let brackets = 0;
  let inStr = false;
  let escape = false;

  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") braces++;
    if (ch === "}") braces--;
    if (ch === "[") brackets++;
    if (ch === "]") brackets--;
  }

  // Close unclosed string
  if (inStr) s += '"';

  // Close unclosed braces/brackets
  while (brackets > 0) { s += "]"; brackets--; }
  while (braces > 0) { s += "}"; braces--; }

  return s;
}
