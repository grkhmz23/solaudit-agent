import type { ParsedProgram, AuditGraph, GraphNode, GraphEdge } from "../types";

/**
 * Build Authority Flow Graph:
 * Shows how signing authority flows through instructions,
 * which accounts require signer privileges, and authority
 * delegation chains.
 */
export function buildAuthorityFlowGraph(program: ParsedProgram): AuditGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  function addNode(id: string, label: string, type: string, meta?: Record<string, unknown>) {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push({ id, label, type, metadata: meta });
  }

  // Add instruction nodes
  for (const ix of program.instructions) {
    addNode(`ix:${ix.name}`, ix.name, "instruction", {
      file: ix.file,
      line: ix.line,
      signerChecks: ix.signerChecks,
    });

    // Add account nodes accessed in this instruction
    for (const acc of ix.accounts) {
      const accId = `acc:${acc.name}`;
      addNode(accId, acc.name, acc.isSigner ? "signer" : "account", {
        isMut: acc.isMut,
        isSigner: acc.isSigner,
        constraints: acc.constraints,
      });

      if (acc.isSigner) {
        edges.push({
          source: accId,
          target: `ix:${ix.name}`,
          label: "signs",
          metadata: { type: "signer_flow" },
        });
      }

      if (acc.isMut) {
        edges.push({
          source: `ix:${ix.name}`,
          target: accId,
          label: "mutates",
          metadata: { type: "mutation" },
        });
      }
    }

    // Authority delegation via has_one or constraint checks
    if (ix.signerChecks.includes("has_one")) {
      edges.push({
        source: `ix:${ix.name}`,
        target: `ix:${ix.name}`,
        label: "has_one_check",
        metadata: { type: "authority_validation" },
      });
    }
  }

  // Add account struct authority fields
  for (const acc of program.accounts) {
    addNode(`struct:${acc.name}`, acc.name, "account_struct", {
      file: acc.file,
      line: acc.line,
      fieldCount: acc.fields.length,
    });

    for (const field of acc.fields) {
      if (field.name.includes("authority") || field.name.includes("owner") || field.name.includes("admin")) {
        addNode(`field:${acc.name}.${field.name}`, `${acc.name}.${field.name}`, "authority_field", {
          type: field.type,
        });
        edges.push({
          source: `field:${acc.name}.${field.name}`,
          target: `struct:${acc.name}`,
          label: "controls",
          metadata: { type: "authority_binding" },
        });
      }
    }
  }

  return { name: "Authority Flow Graph", nodes, edges };
}

/**
 * Query reachability: can a given account reach a target instruction
 * without proper signer checks?
 */
export function queryAuthorityReachability(
  graph: AuditGraph,
  sourceId: string,
  targetId: string
): { reachable: boolean; path: string[] } {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source)!.push(edge.target);
  }

  const visited = new Set<string>();
  const queue: Array<{ node: string; path: string[] }> = [{ node: sourceId, path: [sourceId] }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.node === targetId) {
      return { reachable: true, path: current.path };
    }
    if (visited.has(current.node)) continue;
    visited.add(current.node);

    const neighbors = adjacency.get(current.node) || [];
    for (const next of neighbors) {
      if (!visited.has(next)) {
        queue.push({ node: next, path: [...current.path, next] });
      }
    }
  }

  return { reachable: false, path: [] };
}
