import type { FindingResult, FixPlan, BlastRadius, ParsedProgram } from "../types";

/**
 * Fix patterns library: maps vulnerability classes to minimal fix patterns
 */
const FIX_PATTERNS: Record<number, (finding: FindingResult, program: ParsedProgram) => FixPlan> = {
  1: (f, p) => ({
    pattern: "add_signer_constraint",
    description: `Add signer verification for the authority account in '${f.location.instruction}'.`,
    code: p.framework === "anchor"
      ? `#[account(signer)]\npub authority: Signer<'info>,`
      : `if !authority_info.is_signer {\n    return Err(ProgramError::MissingRequiredSignature);\n}`,
    regressionTests: [
      `Test ${f.location.instruction} with non-signer authority (expect failure)`,
      `Test ${f.location.instruction} with correct signer (expect success)`,
    ],
  }),

  2: (f, p) => ({
    pattern: "add_owner_check",
    description: `Verify account owner matches expected program in '${f.location.instruction}'.`,
    code: p.framework === "anchor"
      ? `pub account: Account<'info, YourAccountType>,`
      : `if *account.owner != program_id {\n    return Err(ProgramError::IncorrectProgramId);\n}`,
    regressionTests: [
      `Test with account owned by wrong program (expect failure)`,
    ],
  }),

  3: (_f, _p) => ({
    pattern: "fix_pda_derivation",
    description: "Use canonical bump and include user-specific seeds.",
    code: `seeds = [b"prefix", authority.key().as_ref()],\nbump`,
    regressionTests: [
      `Test PDA derivation with correct seeds`,
      `Test that non-canonical bump is rejected`,
    ],
  }),

  4: (_f, p) => ({
    pattern: "validate_cpi_target",
    description: "Validate CPI target program ID before invoke.",
    code: p.framework === "anchor"
      ? `pub target_program: Program<'info, ExpectedProgram>,`
      : `if *program_account.key != expected_program::id() {\n    return Err(ProgramError::IncorrectProgramId);\n}`,
    regressionTests: [
      `Test CPI with wrong program ID (expect failure)`,
    ],
  }),

  5: (_f, _p) => ({
    pattern: "add_discriminator",
    description: "Add 8-byte discriminator to account struct and validate on deserialization.",
    code: `// Use Anchor's Account<'info, T> or add manual discriminator check:\nconst DISCRIMINATOR: [u8; 8] = /* sha256("account:YourStruct")[:8] */;`,
    regressionTests: [
      `Test deserialization with wrong account type (expect failure)`,
    ],
  }),

  6: (f, p) => ({
    pattern: "prevent_reinitialization",
    description: `Prevent re-initialization of account in '${f.location.instruction}'.`,
    code: p.framework === "anchor"
      ? `#[account(init, payer = payer, space = 8 + YourStruct::INIT_SPACE)]`
      : `if account_data.is_initialized {\n    return Err(ProgramError::AccountAlreadyInitialized);\n}`,
    regressionTests: [
      `Test calling init twice on same account (expect failure on second)`,
    ],
  }),

  7: (_f, p) => ({
    pattern: "zero_on_close",
    description: "Zero account data before draining lamports.",
    code: p.framework === "anchor"
      ? `#[account(mut, close = recipient)]`
      : `{\n    let mut data = account.try_borrow_mut_data()?;\n    data.fill(0);\n}\n**account.try_borrow_mut_lamports()? = 0;`,
    regressionTests: [
      `Test that closed account cannot be revived in same tx`,
    ],
  }),

  8: (_f, _p) => ({
    pattern: "zero_realloc",
    description: "Zero-initialize extended memory on realloc.",
    code: `#[account(mut, realloc = new_size, realloc::payer = payer, realloc::zero = true)]`,
    regressionTests: [
      `Test that reallocated memory is zeroed`,
    ],
  }),

  9: (f, _p) => ({
    pattern: "checked_math",
    description: "Use checked arithmetic for all value computations.",
    code: `let result = a.checked_add(b).ok_or(ErrorCode::MathOverflow)?;\nlet result = a.checked_sub(b).ok_or(ErrorCode::MathUnderflow)?;`,
    regressionTests: [
      `Test ${f.location.instruction} with u64::MAX values`,
      `Test ${f.location.instruction} with zero values`,
    ],
  }),

  10: (f, _p) => ({
    pattern: "add_state_guard",
    description: `Add state validation before executing '${f.location.instruction}'.`,
    code: `require!(\n    account.state == ExpectedState::Ready,\n    ErrorCode::InvalidState\n);`,
    regressionTests: [
      `Test ${f.location.instruction} in each invalid state (expect failure)`,
      `Test ${f.location.instruction} in valid state (expect success)`,
    ],
  }),

  11: (_f, _p) => ({
    pattern: "validate_remaining_accounts",
    description: "Validate identity and ownership of all remaining accounts.",
    code: `for acc in ctx.remaining_accounts.iter() {\n    require!(acc.owner == &expected::ID, ErrorCode::InvalidAccount);\n}\nrequire!(ctx.remaining_accounts.len() <= MAX, ErrorCode::TooManyAccounts);`,
    regressionTests: [
      `Test with injected unauthorized accounts (expect failure)`,
    ],
  }),

  12: (_f, _p) => ({
    pattern: "oracle_validation",
    description: "Validate oracle owner, staleness, and confidence interval.",
    code: `// Owner check\nrequire!(oracle.owner == &pyth::ID, ErrorCode::InvalidOracle);\n// Staleness\nlet age = Clock::get()?.unix_timestamp - feed.timestamp;\nrequire!(age < MAX_ORACLE_AGE_SECS, ErrorCode::StaleOracle);\n// Confidence\nrequire!(feed.conf < feed.price / 20, ErrorCode::OracleUncertain);`,
    regressionTests: [
      `Test with fake oracle (wrong owner)`,
      `Test with stale price feed`,
      `Test with wide confidence interval`,
    ],
  }),

  13: (_f, _p) => ({
    pattern: "validate_token_accounts",
    description: "Verify token account mint and authority match expected values.",
    code: `#[account(\n    token::mint = expected_mint,\n    token::authority = expected_authority,\n)]\npub vault: Account<'info, TokenAccount>,`,
    regressionTests: [
      `Test with wrong mint token account (expect failure)`,
      `Test with wrong authority (expect failure)`,
    ],
  }),

  14: (_f, _p) => ({
    pattern: "post_cpi_reload",
    description: "Reload account data after CPI before reading it.",
    code: `// After CPI:\naccount.reload()?;\nlet fresh_amount = account.amount;`,
    regressionTests: [
      `Test that post-CPI reads reflect updated state`,
    ],
  }),

  15: (f, p) => ({
    pattern: "key_inequality_check",
    description: "Ensure paired mutable accounts are distinct.",
    code: p.framework === "anchor"
      ? `#[account(constraint = source.key() != dest.key() @ ErrorCode::DuplicateAccount)]`
      : `if source.key == dest.key {\n    return Err(ProgramError::InvalidArgument);\n}`,
    regressionTests: [
      `Test ${f.location.instruction} with same account for both parameters (expect failure)`,
    ],
  }),
};

/**
 * Enrich findings with fix plans and blast radius analysis
 */
export function planRemediation(
  findings: FindingResult[],
  program: ParsedProgram
): FindingResult[] {
  return findings.map((finding) => {
    // Generate fix plan if not already present
    if (!finding.fixPlan) {
      const generator = FIX_PATTERNS[finding.classId];
      if (generator) {
        finding.fixPlan = generator(finding, program);
      }
    }

    // Compute blast radius
    finding.blastRadius = computeBlastRadius(finding, program);

    return finding;
  });
}

function computeBlastRadius(
  finding: FindingResult,
  program: ParsedProgram
): BlastRadius {
  const affectedAccounts: string[] = [];
  const affectedInstructions: string[] = [];
  const signerChanges: string[] = [];

  // Find the instruction this finding is in
  const ix = program.instructions.find(
    (i) => i.name === finding.location.instruction
  );

  if (ix) {
    // All mutable accounts in the instruction are affected
    for (const acc of ix.accounts) {
      if (acc.isMut) affectedAccounts.push(acc.name);
    }

    // Find other instructions that touch the same accounts
    for (const otherIx of program.instructions) {
      if (otherIx.name === ix.name) continue;
      const overlap = otherIx.accounts.some((a) =>
        affectedAccounts.includes(a.name)
      );
      if (overlap) affectedInstructions.push(otherIx.name);
    }

    // Identify signer changes needed
    if (finding.classId === 1) {
      signerChanges.push(`Add signer requirement to ${finding.location.instruction}`);
    }
  }

  return { affectedAccounts, affectedInstructions, signerChanges };
}
