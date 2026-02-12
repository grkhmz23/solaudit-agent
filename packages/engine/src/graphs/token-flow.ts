import type { ParsedProgram, AuditGraph, GraphNode, GraphEdge } from "../types";

/**
 * Build Token / Asset Flow Graph:
 * Tracks how SOL and SPL tokens move between accounts across instructions.
 */
export function buildTokenFlowGraph(program: ParsedProgram): AuditGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();

  function addNode(id: string, label: string, type: string, meta?: Record<string, unknown>) {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push({ id, label, type, metadata: meta });
  }

  for (const ix of program.instructions) {
    addNode(`ix:${ix.name}`, ix.name, "instruction");

    const body = ix.body;

    // Detect SOL transfers (lamport manipulation)
    if (body.includes("lamports") && (body.includes("+=") || body.includes("-="))) {
      const sources = body.matchAll(/(\w+)\.(?:try_borrow_mut_)?lamports\(\)\s*.*-=/g);
      const dests = body.matchAll(/(\w+)\.(?:try_borrow_mut_)?lamports\(\)\s*.*\+=/g);
      for (const s of sources) {
        addNode(`acc:${s[1]}`, s[1], "sol_source");
        edges.push({ source: `acc:${s[1]}`, target: `ix:${ix.name}`, label: "sends_sol" });
      }
      for (const d of dests) {
        addNode(`acc:${d[1]}`, d[1], "sol_dest");
        edges.push({ source: `ix:${ix.name}`, target: `acc:${d[1]}`, label: "receives_sol" });
      }
    }

    // Detect system_program::transfer
    if (body.includes("system_program::transfer") || body.includes("Transfer {")) {
      addNode(`sys:transfer:${ix.name}`, "system_transfer", "transfer_cpi");
      edges.push({ source: `ix:${ix.name}`, target: `sys:transfer:${ix.name}`, label: "cpi_transfer" });
    }

    // Detect SPL token transfers
    if (body.includes("token::transfer") || body.includes("Transfer {") || body.includes("transfer_checked")) {
      addNode(`spl:transfer:${ix.name}`, "token_transfer", "spl_transfer");
      edges.push({ source: `ix:${ix.name}`, target: `spl:transfer:${ix.name}`, label: "spl_transfer" });

      // Try to find from/to accounts
      const fromMatch = body.match(/from\s*[:=]\s*(?:ctx\.accounts\.)?(\w+)/);
      const toMatch = body.match(/to\s*[:=]\s*(?:ctx\.accounts\.)?(\w+)/);
      if (fromMatch) {
        addNode(`acc:${fromMatch[1]}`, fromMatch[1], "token_source");
        edges.push({ source: `acc:${fromMatch[1]}`, target: `spl:transfer:${ix.name}`, label: "from" });
      }
      if (toMatch) {
        addNode(`acc:${toMatch[1]}`, toMatch[1], "token_dest");
        edges.push({ source: `spl:transfer:${ix.name}`, target: `acc:${toMatch[1]}`, label: "to" });
      }
    }

    // Detect mint operations
    if (body.includes("token::mint_to") || body.includes("MintTo")) {
      addNode(`spl:mint:${ix.name}`, "mint_to", "spl_mint");
      edges.push({ source: `ix:${ix.name}`, target: `spl:mint:${ix.name}`, label: "mints" });
    }

    // Detect burn operations
    if (body.includes("token::burn") || body.includes("Burn {")) {
      addNode(`spl:burn:${ix.name}`, "burn", "spl_burn");
      edges.push({ source: `ix:${ix.name}`, target: `spl:burn:${ix.name}`, label: "burns" });
    }
  }

  return { name: "Token Flow Graph", nodes, edges };
}
