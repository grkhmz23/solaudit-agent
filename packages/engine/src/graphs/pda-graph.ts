import type { ParsedProgram, AuditGraph, GraphNode, GraphEdge } from "../types";

/**
 * Build PDA (Program Derived Address) Graph:
 * Maps all PDAs, their seeds, bump handling, and relationships
 * between PDAs and the instructions that derive/use them.
 */
export function buildPDAGraph(program: ParsedProgram): AuditGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  function addNode(id: string, label: string, type: string, meta?: Record<string, unknown>) {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push({ id, label, type, metadata: meta });
  }

  // Add PDA nodes from derivations
  for (const pda of program.pdaDerivations) {
    const seedStr = pda.seeds.join(", ");
    const pdaId = `pda:${pda.file}:${pda.line}`;

    addNode(pdaId, `PDA[${seedStr}]`, "pda", {
      seeds: pda.seeds,
      seedCount: pda.seeds.length,
      bumpHandling: pda.bumpHandling,
      file: pda.file,
      line: pda.line,
    });

    // Connect to instruction
    addNode(`ix:${pda.instruction}`, pda.instruction, "instruction");
    edges.push({
      source: `ix:${pda.instruction}`,
      target: pdaId,
      label: "derives",
      metadata: { bumpHandling: pda.bumpHandling },
    });

    // Add seed nodes
    for (const seed of pda.seeds) {
      const seedId = `seed:${seed.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      addNode(seedId, seed, "seed");
      edges.push({
        source: seedId,
        target: pdaId,
        label: "seeds_into",
      });
    }
  }

  // Cross-reference with account structs that use seeds
  for (const acc of program.accounts) {
    for (const file of program.files) {
      // Look for seeds annotations on this account struct
      const structRegex = new RegExp(`seeds\\s*=.*?${acc.name}`, "s");
      if (structRegex.test(file.content)) {
        const accId = `struct:${acc.name}`;
        addNode(accId, acc.name, "account_struct");

        // Link to matching PDA derivations
        for (const pda of program.pdaDerivations) {
          if (pda.file === file.path || file.path.endsWith(pda.file)) {
            edges.push({
              source: `pda:${pda.file}:${pda.line}`,
              target: accId,
              label: "resolves_to",
            });
          }
        }
      }
    }
  }

  // Detect potential PDA collisions: same seeds used in different instructions
  const seedSignatures = new Map<string, string[]>();
  for (const pda of program.pdaDerivations) {
    const sig = pda.seeds.sort().join("|");
    if (!seedSignatures.has(sig)) seedSignatures.set(sig, []);
    seedSignatures.get(sig)!.push(pda.instruction);
  }

  for (const [sig, instructions] of seedSignatures) {
    if (instructions.length > 1) {
      const collisionId = `collision:${sig}`;
      addNode(collisionId, `Potential Collision: [${sig}]`, "collision_risk", {
        instructions,
      });
      for (const ix of instructions) {
        edges.push({
          source: `ix:${ix}`,
          target: collisionId,
          label: "shared_seeds",
        });
      }
    }
  }

  return { name: "PDA Graph", nodes, edges };
}
