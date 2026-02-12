import * as fs from "fs";
import * as path from "path";
import type {
  ParsedProgram,
  ParsedFile,
  ParsedInstruction,
  ParsedAccountStruct,
  CPICall,
  PDADerivation,
  InstructionAccount,
  AccountField,
  ArithmeticOp,
  ErrorCode,
} from "../types";

/**
 * Recursively find all .rs files in a directory
 */
function findRustFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "target" && entry.name !== ".git" && entry.name !== "node_modules") {
      results.push(...findRustFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Detect framework: anchor if Cargo.toml has anchor-lang, otherwise native
 */
function detectFramework(repoPath: string): "anchor" | "native" | "unknown" {
  const cargoFiles = findFiles(repoPath, "Cargo.toml");
  for (const cf of cargoFiles) {
    const content = fs.readFileSync(cf, "utf-8");
    if (content.includes("anchor-lang")) return "anchor";
  }
  // Check for entrypoint! macro in any .rs file
  const rsFiles = findRustFiles(repoPath);
  for (const rf of rsFiles) {
    const content = fs.readFileSync(rf, "utf-8");
    if (content.includes("entrypoint!") || content.includes("process_instruction")) {
      return "native";
    }
  }
  return "unknown";
}

function findFiles(dir: string, name: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "target" && entry.name !== ".git" && entry.name !== "node_modules") {
        results.push(...findFiles(full, name));
      } else if (entry.isFile() && entry.name === name) {
        results.push(full);
      }
    }
  } catch {
    // skip unreadable directories
  }
  return results;
}

/**
 * Extract program name from Cargo.toml or directory
 */
function extractProgramName(repoPath: string): string {
  const cargoFiles = findFiles(repoPath, "Cargo.toml");
  for (const cf of cargoFiles) {
    const content = fs.readFileSync(cf, "utf-8");
    const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch && !nameMatch[1].includes("test")) return nameMatch[1];
  }
  return path.basename(repoPath);
}

/**
 * Parse Anchor instructions from #[program] module
 */
function parseAnchorInstructions(file: ParsedFile, repoPath: string): ParsedInstruction[] {
  const instructions: ParsedInstruction[] = [];
  const lines = file.lines;
  const relPath = path.relative(repoPath, file.path);

  // Find function definitions inside program modules
  let inProgramMod = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes("#[program]")) {
      inProgramMod = true;
      continue;
    }

    if (inProgramMod) {
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;
      if (braceDepth <= 0 && i > 0) {
        inProgramMod = false;
        continue;
      }

      // Match pub fn name(ctx: Context<...>, ...)
      const fnMatch = line.match(/pub\s+fn\s+(\w+)\s*[<(]/);
      if (fnMatch) {
        const name = fnMatch[1];
        const startLine = i + 1;
        // Find function end
        let fnBraces = 0;
        let endIdx = i;
        for (let j = i; j < lines.length; j++) {
          fnBraces += (lines[j].match(/{/g) || []).length;
          fnBraces -= (lines[j].match(/}/g) || []).length;
          if (fnBraces <= 0 && j > i) {
            endIdx = j;
            break;
          }
        }

        const body = lines.slice(i, endIdx + 1).join("\n");

        instructions.push({
          name,
          file: relPath,
          line: startLine,
          endLine: endIdx + 1,
          body,
          accounts: extractInstructionAccounts(body, lines, i),
          signerChecks: extractSignerChecks(body),
          ownerChecks: extractOwnerChecks(body),
          cpiCalls: extractCPICalls(body),
          arithmeticOps: extractArithmeticOps(body, relPath, startLine),
        });
      }
    }
  }

  // Also try to find non-program-module fns that look like instruction handlers
  if (instructions.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      const fnMatch = lines[i].match(/pub\s+fn\s+(\w+)\s*\(\s*ctx\s*:\s*Context/);
      if (fnMatch) {
        const name = fnMatch[1];
        let fnBraces = 0;
        let endIdx = i;
        for (let j = i; j < lines.length; j++) {
          fnBraces += (lines[j].match(/{/g) || []).length;
          fnBraces -= (lines[j].match(/}/g) || []).length;
          if (fnBraces <= 0 && j > i) { endIdx = j; break; }
        }
        const body = lines.slice(i, endIdx + 1).join("\n");
        instructions.push({
          name,
          file: relPath,
          line: i + 1,
          endLine: endIdx + 1,
          body,
          accounts: extractInstructionAccounts(body, lines, i),
          signerChecks: extractSignerChecks(body),
          ownerChecks: extractOwnerChecks(body),
          cpiCalls: extractCPICalls(body),
          arithmeticOps: extractArithmeticOps(body, relPath, i + 1),
        });
      }
    }
  }

  return instructions;
}

/**
 * Parse native Solana program instructions from process_instruction
 */
function parseNativeInstructions(file: ParsedFile, repoPath: string): ParsedInstruction[] {
  const instructions: ParsedInstruction[] = [];
  const lines = file.lines;
  const relPath = path.relative(repoPath, file.path);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match fn process_instruction or fn process_ variants
    const fnMatch = line.match(/(?:pub\s+)?fn\s+(process_\w+|handle_\w+)\s*\(/);
    if (fnMatch) {
      const name = fnMatch[1];
      let fnBraces = 0;
      let endIdx = i;
      for (let j = i; j < lines.length; j++) {
        fnBraces += (lines[j].match(/{/g) || []).length;
        fnBraces -= (lines[j].match(/}/g) || []).length;
        if (fnBraces <= 0 && j > i) { endIdx = j; break; }
      }
      const body = lines.slice(i, endIdx + 1).join("\n");
      instructions.push({
        name,
        file: relPath,
        line: i + 1,
        endLine: endIdx + 1,
        body,
        accounts: extractNativeAccounts(body),
        signerChecks: extractSignerChecks(body),
        ownerChecks: extractOwnerChecks(body),
        cpiCalls: extractCPICalls(body),
        arithmeticOps: extractArithmeticOps(body, relPath, i + 1),
      });
    }
  }
  return instructions;
}

function extractInstructionAccounts(body: string, _lines: string[], _startIdx: number): InstructionAccount[] {
  const accounts: InstructionAccount[] = [];
  // Look for ctx.accounts.X patterns
  const accesses = body.matchAll(/ctx\.accounts\.(\w+)/g);
  const seen = new Set<string>();
  for (const m of accesses) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const isSigner = body.includes(`${m[1]}.is_signer`) ||
      body.includes(`Signer`) ||
      new RegExp(`#\\[account\\([^)]*signer[^)]*\\)]\\s*.*${m[1]}`, "s").test(body);
    const isMut = body.includes(`mut ${m[1]}`) ||
      new RegExp(`#\\[account\\([^)]*mut[^)]*\\)]\\s*.*${m[1]}`, "s").test(body);
    accounts.push({
      name: m[1],
      isSigner,
      isMut,
      constraints: [],
    });
  }
  return accounts;
}

function extractNativeAccounts(body: string): InstructionAccount[] {
  const accounts: InstructionAccount[] = [];
  // Match next_account_info patterns
  const matches = body.matchAll(/let\s+(\w+)\s*=\s*next_account_info/g);
  for (const m of matches) {
    accounts.push({
      name: m[1],
      isSigner: body.includes(`${m[1]}.is_signer`),
      isMut: body.includes(`${m[1]}.is_writable`),
      constraints: [],
    });
  }
  return accounts;
}

function extractSignerChecks(body: string): string[] {
  const checks: string[] = [];
  if (body.includes("is_signer")) checks.push("is_signer");
  if (body.includes("#[account(signer") || body.includes("Signer<")) checks.push("anchor_signer");
  if (body.includes("has_one")) checks.push("has_one");
  if (body.match(/constraint\s*=.*key\(\)/)) checks.push("key_constraint");
  return checks;
}

function extractOwnerChecks(body: string): string[] {
  const checks: string[] = [];
  if (body.includes(".owner") && (body.includes("==") || body.includes("require!"))) checks.push("owner_check");
  if (body.includes("Account<") || body.includes("Program<")) checks.push("anchor_account_type");
  if (body.includes("token::authority")) checks.push("token_authority");
  return checks;
}

function extractCPICalls(body: string): string[] {
  const calls: string[] = [];
  const patterns = [
    /invoke(?:_signed)?\s*\(/g,
    /CpiContext/g,
    /token::\w+/g,
    /system_program::\w+/g,
    /anchor_lang::solana_program::program::invoke/g,
  ];
  for (const p of patterns) {
    const matches = body.matchAll(p);
    for (const m of matches) calls.push(m[0]);
  }
  return calls;
}

function extractArithmeticOps(body: string, file: string, baseLine: number): ArithmeticOp[] {
  const ops: ArithmeticOp[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for unchecked arithmetic
    if (line.match(/[+\-*\/]\s*[^=]/) && !line.trimStart().startsWith("//")) {
      const isChecked = line.includes("checked_") ||
        line.includes(".checked_add") ||
        line.includes(".checked_sub") ||
        line.includes(".checked_mul") ||
        line.includes(".checked_div") ||
        line.includes("try_") ||
        line.includes("saturating_");
      const opMatch = line.match(/([+\-*\/])/);
      if (opMatch && (line.includes("amount") || line.includes("balance") || line.includes("lamports") || line.includes("price") || line.includes("fee") || line.includes("u64") || line.includes("u128"))) {
        ops.push({
          file,
          line: baseLine + i,
          op: opMatch[1],
          checked: isChecked,
        });
      }
    }
  }
  return ops;
}

/**
 * Parse account structs (#[derive(Accounts)] or #[account])
 */
function parseAccountStructs(file: ParsedFile, repoPath: string): ParsedAccountStruct[] {
  const structs: ParsedAccountStruct[] = [];
  const lines = file.lines;
  const relPath = path.relative(repoPath, file.path);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Anchor #[derive(Accounts)] pattern
    if (line.includes("#[derive(Accounts)]") || line.includes("#[account]") || line.includes("#[account(")) {
      // Find the struct definition
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const structMatch = lines[j].match(/pub\s+struct\s+(\w+)/);
        if (structMatch) {
          const name = structMatch[1];
          const fields: AccountField[] = [];
          let hasInit = false;
          let hasClose = false;

          // Parse struct body
          let braces = 0;
          for (let k = j; k < lines.length; k++) {
            braces += (lines[k].match(/{/g) || []).length;
            braces -= (lines[k].match(/}/g) || []).length;

            if (lines[k].includes("init")) hasInit = true;
            if (lines[k].includes("close")) hasClose = true;

            const fieldMatch = lines[k].match(/pub\s+(\w+)\s*:\s*(.+)/);
            if (fieldMatch) {
              fields.push({
                name: fieldMatch[1],
                type: fieldMatch[2].replace(/[,\s]+$/, ""),
                line: k + 1,
              });
            }

            if (braces <= 0 && k > j) break;
          }

          structs.push({
            name,
            file: relPath,
            line: j + 1,
            fields,
            hasInitCheck: hasInit,
            hasCloseHandler: hasClose,
          });
          break;
        }
      }
    }
  }
  return structs;
}

/**
 * Parse CPI calls with context
 */
function parseCPICalls(file: ParsedFile, repoPath: string): CPICall[] {
  const calls: CPICall[] = [];
  const lines = file.lines;
  const relPath = path.relative(repoPath, file.path);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // invoke or invoke_signed
    if (line.match(/invoke(?:_signed)?\s*\(/) || line.includes("CpiContext::new")) {
      // Determine which instruction this is in
      let instruction = "unknown";
      for (let j = i; j >= 0; j--) {
        const fnMatch = lines[j].match(/(?:pub\s+)?fn\s+(\w+)/);
        if (fnMatch) { instruction = fnMatch[1]; break; }
      }

      // Check if program ID is validated
      const surroundingCode = lines.slice(Math.max(0, i - 10), Math.min(lines.length, i + 10)).join("\n");
      const programValidated =
        surroundingCode.includes("program_id") ||
        surroundingCode.includes("Program<") ||
        surroundingCode.includes("token_program") ||
        surroundingCode.includes("system_program");

      // Check for reload after CPI
      const afterCPI = lines.slice(i + 1, Math.min(lines.length, i + 20)).join("\n");
      const accountsAfterCPI: string[] = [];
      const reloadMatch = afterCPI.matchAll(/(\w+)\.reload\(\)/g);
      for (const m of reloadMatch) accountsAfterCPI.push(m[1]);

      calls.push({
        file: relPath,
        line: i + 1,
        instruction,
        targetProgram: extractTargetProgram(surroundingCode),
        programValidated,
        accountsAfterCPI,
      });
    }
  }
  return calls;
}

function extractTargetProgram(code: string): string {
  if (code.includes("token_program") || code.includes("spl_token")) return "spl_token";
  if (code.includes("system_program")) return "system_program";
  if (code.includes("associated_token")) return "associated_token";
  const progMatch = code.match(/program\s*[=:]\s*(\w+)/);
  return progMatch ? progMatch[1] : "unknown";
}

/**
 * Parse PDA derivations
 */
function parsePDADerivations(file: ParsedFile, repoPath: string): PDADerivation[] {
  const derivations: PDADerivation[] = [];
  const lines = file.lines;
  const relPath = path.relative(repoPath, file.path);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Anchor seeds = [...] pattern
    if (line.includes("seeds") && line.includes("=")) {
      const seedsMatch = line.match(/seeds\s*=\s*\[([^\]]*)\]/);
      if (seedsMatch) {
        const seeds = seedsMatch[1].split(",").map((s) => s.trim()).filter(Boolean);

        // Check bump handling
        const surroundingCode = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 5)).join("\n");
        let bumpHandling: "canonical" | "unchecked" | "missing" = "missing";
        if (surroundingCode.includes("bump")) {
          bumpHandling = surroundingCode.includes("bump =") ? "unchecked" : "canonical";
        }

        // Which instruction
        let instruction = "unknown";
        for (let j = i; j >= 0; j--) {
          const fnMatch = lines[j].match(/(?:pub\s+)?fn\s+(\w+)/);
          if (fnMatch) { instruction = fnMatch[1]; break; }
        }

        derivations.push({ file: relPath, line: i + 1, seeds, bumpHandling, instruction });
      }
    }

    // Native Pubkey::find_program_address or create_program_address
    if (line.includes("find_program_address") || line.includes("create_program_address")) {
      const seedsMatch = lines.slice(Math.max(0, i - 2), i + 3).join("\n")
        .match(/\[([^\]]*)\]/);
      const seeds = seedsMatch
        ? seedsMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
        : [];

      let instruction = "unknown";
      for (let j = i; j >= 0; j--) {
        const fnMatch = lines[j].match(/(?:pub\s+)?fn\s+(\w+)/);
        if (fnMatch) { instruction = fnMatch[1]; break; }
      }

      const hasBump = line.includes("find_program_address");
      derivations.push({
        file: relPath,
        line: i + 1,
        seeds,
        bumpHandling: hasBump ? "canonical" : "unchecked",
        instruction,
      });
    }
  }
  return derivations;
}

/**
 * Parse error codes
 */
function parseErrorCodes(file: ParsedFile): ErrorCode[] {
  const errors: ErrorCode[] = [];
  const lines = file.lines;
  let inErrorEnum = false;
  let code = 6000; // Anchor default start

  for (const line of lines) {
    if (line.includes("#[error_code]") || line.includes("ProgramError")) {
      inErrorEnum = true;
      continue;
    }
    if (inErrorEnum) {
      if (line.includes("}")) { inErrorEnum = false; continue; }
      const errMatch = line.match(/#\[msg\("[^"]*"\)\]\s*(\w+)|(\w+)(?:\s*=\s*(\d+))?/);
      if (errMatch) {
        const name = errMatch[1] || errMatch[2];
        if (name && name !== "pub" && name !== "enum") {
          if (errMatch[3]) code = parseInt(errMatch[3]);
          errors.push({ name, code: code++ });
        }
      }
    }
  }
  return errors;
}

/**
 * Main parse function: takes a repo path and returns parsed program data
 */
export function parseRepo(repoPath: string): ParsedProgram {
  const framework = detectFramework(repoPath);
  const name = extractProgramName(repoPath);

  const rsFiles = findRustFiles(repoPath);
  const files: ParsedFile[] = rsFiles.map((fp) => {
    const content = fs.readFileSync(fp, "utf-8");
    return { path: fp, content, lines: content.split("\n") };
  });

  const allInstructions: ParsedInstruction[] = [];
  const allAccountStructs: ParsedAccountStruct[] = [];
  const allCPICalls: CPICall[] = [];
  const allPDADerivations: PDADerivation[] = [];
  const allErrorCodes: ErrorCode[] = [];

  for (const file of files) {
    if (framework === "anchor") {
      allInstructions.push(...parseAnchorInstructions(file, repoPath));
    } else {
      allInstructions.push(...parseNativeInstructions(file, repoPath));
    }
    allAccountStructs.push(...parseAccountStructs(file, repoPath));
    allCPICalls.push(...parseCPICalls(file, repoPath));
    allPDADerivations.push(...parsePDADerivations(file, repoPath));
    allErrorCodes.push(...parseErrorCodes(file));
  }

  // Extract program ID if available
  let programId: string | undefined;
  for (const file of files) {
    const idMatch = file.content.match(/declare_id!\s*\(\s*"([^"]+)"\s*\)/);
    if (idMatch) { programId = idMatch[1]; break; }
  }

  return {
    name,
    programId,
    framework,
    files: files.map((f) => ({ ...f, path: path.relative(repoPath, f.path) })),
    instructions: allInstructions,
    accounts: allAccountStructs,
    cpiCalls: allCPICalls,
    pdaDerivations: allPDADerivations,
    errorCodes: allErrorCodes,
  };
}
