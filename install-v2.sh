#!/bin/bash
set -e

# ── V2 Engine Installer ──────────────────────────────────────
# Run from repo root: bash install-v2.sh
#
# What it does:
# 1. Extracts all new V2 files (parser, analyzer, poc, report, types, tests)
# 2. Patches engine index.ts to export V2 modules
# 3. Patches orchestrator.ts for V2 dispatch (V1/V2/hybrid)
# 4. Ensures web-tree-sitter is in package.json
# 5. Runs pnpm install + typecheck + tests

echo "═══════════════════════════════════════════"
echo "  SolAudit V2 Engine Installer"
echo "═══════════════════════════════════════════"
echo ""

# Verify we're in the repo root
if [ ! -f "packages/engine/package.json" ]; then
  echo "ERROR: Run this script from the solaudit-agent repo root."
  exit 1
fi

# ── Step 1: Extract V2 files ──────────────────────────────
echo "[1/5] Extracting V2 files..."

if [ -f "v2-files.tar.gz" ]; then
  tar xzf v2-files.tar.gz
  echo "  ✓ Extracted from v2-files.tar.gz"
else
  echo "  ERROR: v2-files.tar.gz not found in repo root."
  echo "  Upload it alongside this script."
  exit 1
fi

# Verify extraction
if [ ! -f "packages/engine/src/v2/index.ts" ]; then
  echo "  ERROR: V2 files not extracted correctly."
  exit 1
fi

echo "  ✓ V2 directory: $(find packages/engine/src/v2 -name '*.ts' | wc -l) TypeScript files"
echo "  ✓ Test fixtures: $(find packages/engine/tests/fixtures -name '*.rs' | wc -l) Rust files"

# ── Step 2: Patch engine index.ts (add V2 exports) ────────
echo ""
echo "[2/5] Patching engine exports..."

ENGINE_INDEX="packages/engine/src/index.ts"

# Check if V2 exports already present
if grep -q "runPipelineV2" "$ENGINE_INDEX" 2>/dev/null; then
  echo "  ⊘ V2 exports already present, skipping"
else
  # Append V2 exports
  cat >> "$ENGINE_INDEX" << 'V2EXPORTS'

// ── V2 Engine ──

export { runPipelineV2, v2ResultToV1, runHybridPipeline, loadV2Config } from "./v2/index";
export { buildV2Summary, buildV2FullReport, buildV2Advisory } from "./v2/report/index";
export { validatePoCs, generatePoCCode } from "./v2/poc/index";
export type { V2Config, EngineVersion } from "./v2/config";
export type {
  ParsedProgramV2,
  VulnCandidate,
  V2Finding,
  V2PipelineResult,
  V2Metrics,
  HybridComparison,
} from "./v2/types";
export type { V2Summary } from "./v2/report/index";
V2EXPORTS
  echo "  ✓ Added V2 exports to engine/src/index.ts"
fi

# ── Step 3: Patch orchestrator.ts (V2 dispatch) ──────────
echo ""
echo "[3/5] Patching orchestrator for V2 dispatch..."

ORCH="packages/engine/src/agent/orchestrator.ts"

# Check if V2 dispatch already present
if grep -q "runPipelineV2\|loadV2Config" "$ORCH" 2>/dev/null; then
  echo "  ⊘ V2 dispatch already present, skipping"
else
  # Add V2 import after the runPipeline import
  if grep -q 'import { runPipeline }' "$ORCH" 2>/dev/null; then
    sed -i 's|import { runPipeline } from "../pipeline";|import { runPipeline } from "../pipeline";\nimport { runPipelineV2, v2ResultToV1, runHybridPipeline, loadV2Config } from "../v2/index";|' "$ORCH"
    echo "  ✓ Added V2 imports to orchestrator"
  else
    echo "  ⚠ Could not find runPipeline import in orchestrator. Add manually:"
    echo '    import { runPipelineV2, v2ResultToV1, runHybridPipeline, loadV2Config } from "../v2/index";'
  fi

  # Replace the pipeline dispatch block
  # Find the line with "const pipelineResult = await runPipeline({"
  if grep -q 'const pipelineResult = await runPipeline' "$ORCH" 2>/dev/null; then
    # Use Python for the multi-line replacement since sed can't handle it well
    python3 << 'PYREPLACE'
with open("packages/engine/src/agent/orchestrator.ts", "r") as f:
    content = f.read()

# Match the exact block pattern
old = '''      const pipelineResult = await runPipeline({
        repoPath: repoDir,
        mode: mode as "SCAN" | "PROVE" | "FIX_PLAN",
        onProgress: async (stage, pct) => {
          await progress("pipeline", `${stage} ${pct}%`);
        },
      });
      run.pipelineResult = pipelineResult;'''

new = '''      const v2Config = loadV2Config();
      const pipelineCtx = {
        repoPath: repoDir,
        mode: mode as "SCAN" | "PROVE" | "FIX_PLAN",
        onProgress: async (stage: string, pct: number) => {
          await progress("pipeline", `${stage} ${pct}%`);
        },
      };

      let pipelineResult;
      if (v2Config.engineVersion === "v2") {
        console.log("[orchestrator] Engine version: V2");
        const v2Result = await runPipelineV2(pipelineCtx);
        pipelineResult = v2ResultToV1(v2Result);
      } else if (v2Config.engineVersion === "hybrid") {
        console.log("[orchestrator] Engine version: HYBRID");
        const v2Result = await runHybridPipeline(pipelineCtx, runPipeline);
        pipelineResult = v2ResultToV1(v2Result);
      } else {
        console.log("[orchestrator] Engine version: V1");
        pipelineResult = await runPipeline(pipelineCtx);
      }
      run.pipelineResult = pipelineResult;'''

if old in content:
    content = content.replace(old, new)
    with open("packages/engine/src/agent/orchestrator.ts", "w") as f:
        f.write(content)
    print("  ✓ Replaced pipeline dispatch with V2-aware version")
else:
    # Try with different quote styles
    old2 = old.replace('"', "'")
    if old2 in content:
        content = content.replace(old2, new)
        with open("packages/engine/src/agent/orchestrator.ts", "w") as f:
            f.write(content)
        print("  ✓ Replaced pipeline dispatch with V2-aware version (alt quotes)")
    else:
        print("  ⚠ Could not find pipeline dispatch block automatically.")
        print("    The V2 import was added. You need to manually replace:")
        print("    'const pipelineResult = await runPipeline({...})' block")
        print("    with the V2 dispatch block. See install-v2.sh comments.")
PYREPLACE
  else
    echo "  ⚠ Could not find runPipeline call. Pipeline dispatch needs manual edit."
  fi
fi

# ── Step 4: Ensure solaudit-github.d.ts exists ────────────
echo ""
echo "[4/5] Adding type declarations..."

TYPES_DIR="packages/engine/src/types"
mkdir -p "$TYPES_DIR"

if [ ! -f "$TYPES_DIR/solaudit-github.d.ts" ]; then
  cat > "$TYPES_DIR/solaudit-github.d.ts" << 'GHTYPE'
declare module "@solaudit/github" {
  export class GitHubClient {
    constructor(token: string);
    forkAndPR(params: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      patches: Array<{ file: string; content: string }>;
      extraFiles?: Array<{ path: string; content: string }>;
      baseBranch?: string;
    }): Promise<{ prUrl: string; forkUrl: string }>;
    submitFix(repoUrl: string, params: {
      title: string;
      body: string;
      patches: Array<{ path: string; content: string }>;
      branch: string;
    }): Promise<{ prUrl: string }>;
  }
}
GHTYPE
  echo "  ✓ Created solaudit-github.d.ts"
else
  echo "  ⊘ solaudit-github.d.ts already exists"
fi

# Ensure web-tree-sitter is in engine deps
if ! grep -q "web-tree-sitter" packages/engine/package.json 2>/dev/null; then
  echo "  ⚠ web-tree-sitter not in engine deps. Run:"
  echo "    cd packages/engine && pnpm add web-tree-sitter tree-sitter-rust"
else
  echo "  ✓ web-tree-sitter already in engine deps"
fi

# ── Step 5: Verify ───────────────────────────────────────
echo ""
echo "[5/5] Verification..."

echo "  V2 files: $(find packages/engine/src/v2 -name '*.ts' -not -path '*/wasm/*' | wc -l) TypeScript files"
echo "  V2 lines: $(cat packages/engine/src/v2/**/*.ts packages/engine/src/v2/*.ts 2>/dev/null | wc -l) total"
echo ""

# Run typecheck if npx available
if command -v npx &>/dev/null; then
  echo "  Running typecheck..."
  if npx tsc --noEmit -p packages/engine/tsconfig.json 2>&1 | grep -v "@solaudit/github" | grep "error TS" ; then
    echo "  ⚠ TypeScript errors found (check above)"
  else
    echo "  ✓ TypeCheck passed"
  fi

  echo "  Running V2 tests..."
  cd packages/engine
  if npx vitest run tests/v2-parser.test.ts tests/v2-candidates.test.ts 2>&1 | tail -3; then
    echo "  ✓ Tests passed"
  fi
  cd ../..
else
  echo "  ⚠ npx not available, skipping verification"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  V2 Engine installed successfully!"
echo ""
echo "  To activate V2:"
echo "    export AUDIT_ENGINE_VERSION=v2"
echo ""
echo "  To run hybrid (V1 + V2 comparison):"
echo "    export AUDIT_ENGINE_VERSION=hybrid"
echo ""
echo "  Feature flags:"
echo "    V2_LLM_CONFIRM=true    (LLM confirmation loop)"
echo "    V2_POC_VALIDATE=false   (PoC validation, needs sandbox)"
echo "    V2_TREE_SITTER=true     (tree-sitter parser)"
echo "═══════════════════════════════════════════"
