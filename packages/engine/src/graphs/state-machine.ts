import type { ParsedProgram, AuditGraph, GraphNode, GraphEdge } from "../types";

/**
 * Build State Machine Graph:
 * Reconstructs program state transitions from enum fields,
 * match arms, and conditional transitions in instruction bodies.
 */
export function buildStateMachineGraph(program: ParsedProgram): AuditGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  function addNode(id: string, label: string, type: string, meta?: Record<string, unknown>) {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push({ id, label, type, metadata: meta });
  }

  // Find enum types that look like states
  const stateEnums: Array<{ name: string; variants: string[]; file: string }> = [];

  for (const file of program.files) {
    const lines = file.lines;
    for (let i = 0; i < lines.length; i++) {
      const enumMatch = lines[i].match(/pub\s+enum\s+(\w*(?:State|Status|Phase|Stage)\w*)/);
      if (enumMatch) {
        const enumName = enumMatch[1];
        const variants: string[] = [];
        let braces = 0;
        for (let j = i; j < lines.length; j++) {
          braces += (lines[j].match(/{/g) || []).length;
          braces -= (lines[j].match(/}/g) || []).length;
          const variantMatch = lines[j].match(/^\s*(\w+)/);
          if (variantMatch && !lines[j].includes("enum") && !lines[j].includes("{") && !lines[j].includes("}") && !lines[j].includes("//") && !lines[j].includes("pub")) {
            variants.push(variantMatch[1]);
          }
          if (braces <= 0 && j > i) break;
        }
        if (variants.length > 0) {
          stateEnums.push({ name: enumName, variants, file: file.path });
        }
      }
    }
  }

  // Add state nodes from enums
  for (const se of stateEnums) {
    addNode(`enum:${se.name}`, se.name, "state_enum");
    for (const variant of se.variants) {
      addNode(`state:${se.name}:${variant}`, variant, "state", {
        enum: se.name,
      });
    }
  }

  // Analyze instructions for state transitions
  for (const ix of program.instructions) {
    addNode(`ix:${ix.name}`, ix.name, "instruction");

    // Look for state assignments: x.state = State::Variant
    const assignments = ix.body.matchAll(/(\w+)\s*=\s*(?:\w+::)?(\w+)/g);
    for (const m of assignments) {
      // Check if the variant matches any known state enum
      for (const se of stateEnums) {
        if (se.variants.includes(m[2])) {
          edges.push({
            source: `ix:${ix.name}`,
            target: `state:${se.name}:${m[2]}`,
            label: "transitions_to",
            metadata: { field: m[1] },
          });
        }
      }
    }

    // Look for match arms on state-like fields: match x.state { ... }
    const matchBlocks = ix.body.matchAll(/match\s+\w+\.(\w+)\s*\{([^}]*)\}/gs);
    for (const mb of matchBlocks) {
      const fieldName = mb[1];
      const arms = mb[2].matchAll(/(\w+)\s*=>/g);
      for (const arm of arms) {
        for (const se of stateEnums) {
          if (se.variants.includes(arm[1])) {
            edges.push({
              source: `state:${se.name}:${arm[1]}`,
              target: `ix:${ix.name}`,
              label: "requires_state",
              metadata: { field: fieldName },
            });
          }
        }
      }
    }

    // Look for require!/assert checks on state
    const stateChecks = ix.body.matchAll(/(?:require|assert)!\s*\(\s*\w+\.(\w+)\s*==\s*(?:\w+::)?(\w+)/g);
    for (const sc of stateChecks) {
      for (const se of stateEnums) {
        if (se.variants.includes(sc[2])) {
          edges.push({
            source: `state:${se.name}:${sc[2]}`,
            target: `ix:${ix.name}`,
            label: "guards",
            metadata: { field: sc[1] },
          });
        }
      }
    }
  }

  // If no explicit state enums found, infer state-like behavior from boolean flags
  if (stateEnums.length === 0) {
    for (const acc of program.accounts) {
      for (const field of acc.fields) {
        if (field.name.includes("initialized") || field.name.includes("is_") ||
            field.name.includes("active") || field.name.includes("closed") ||
            field.name.includes("claimed") || field.name.includes("locked")) {
          addNode(`flag:${acc.name}.${field.name}`, `${acc.name}.${field.name}`, "state_flag", {
            type: field.type,
          });
        }
      }
    }
  }

  return { name: "State Machine Graph", nodes, edges };
}
