// Explains why a transaction failed. The facts come from the transaction's own error and logs; the words for a custom error
// code come from the program's IDL (see tables.generated.ts), and when the program also logged its own error name the two are
// compared, so a table that has gone stale against the deployed program is reported instead of silently wrong.
import { ANCHOR_FRAMEWORK, ANCHOR_VERSION, PROGRAMS, type ProgramTable } from './tables.generated.js';

export type Category = 'slippage' | 'balance' | 'account' | 'authority' | 'compute' | 'blockhash' | 'state' | 'math' | 'program-rule' | 'network' | 'unknown';

export interface Diagnosis {
  /** One plain sentence: what went wrong. */
  summary: string;
  category: Category;
  where: { instructionIndex: number | null; program: { address: string; name: string; label: string } | null; callDepth: number | null; instruction: string | null };
  error: {
    source: 'program' | 'anchor-framework' | 'runtime' | 'transaction' | 'program-log' | 'unmapped';
    code: number | null;
    name: string | null;
    message: string | null;
    /** The table the words came from, so a reader can judge how current they are. */
    table: { label: string; version: string | null; source: string } | null;
  };
  /** What the program itself logged about the error, when it logged one (Anchor programs do). */
  programLog: { name: string; number: number; message: string; account: string | null; file: string | null } | null;
  /** True when the table and the program's own log name the same error, false when they disagree (the table is stale), null when there is nothing to compare. */
  tableAgreesWithProgram: boolean | null;
  advice: string[];
  /** The log lines the diagnosis rests on. */
  evidence: string[];
}

export interface FailedTransaction {
  /** The `err` of the transaction status: `{ InstructionError: [index, detail] }` or a transaction error string or object. */
  err: unknown;
  logs?: readonly string[] | null;
  /** Program ids of the top-level instructions in order, used when the logs are missing. */
  instructionPrograms?: readonly string[] | null;
}

interface Frame {
  program: string;
  depth: number;
  top: number;
  instruction: string | null;
  anchor: Diagnosis['programLog'];
  lines: string[];
}

const ANCHOR_LOG = /AnchorError (?:caused by account: (\w+)\. |thrown in ([^\s:]+:\d+)\. |occurred\. )Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/;

/** Finds the innermost instruction that failed, from the logs. */
export function failingFrame(logs: readonly string[]): { frame: Frame; reason: string } | null {
  const stack: Frame[] = [];
  let top = -1;
  for (const raw of logs) {
    const line = raw.trim();
    let m = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (m) {
      const depth = Number(m[2]);
      if (depth === 1) top += 1;
      stack.push({ program: m[1]!, depth, top, instruction: null, anchor: null, lines: [line] });
      continue;
    }
    const cur = stack[stack.length - 1];
    if (cur) cur.lines.push(line);
    m = /^Program log: Instruction: (.+)$/.exec(line);
    if (m && cur) cur.instruction = m[1]!;
    m = ANCHOR_LOG.exec(line.replace(/^Program log: /, ''));
    if (m && cur && line.includes('AnchorError')) cur.anchor = { account: m[1] ?? null, file: m[2] ?? null, name: m[3]!, number: Number(m[4]), message: m[5]! };
    m = /^Program (\w+) failed: (.*)$/.exec(line);
    if (m) {
      const f = stack[stack.length - 1];
      if (f && f.program === m[1]) return { frame: f, reason: m[2]! };
    }
    if (/^Program \w+ success$/.test(line)) stack.pop();
  }
  return null;
}

const table = (address: string): ProgramTable | undefined => PROGRAMS.find((p) => p.address === address);

// InstructionError variants that carry no code, in plain words.
const RUNTIME: Record<string, { text: string; category: Category; advice: string[] }> = {
  ComputationalBudgetExceeded: { text: 'The transaction used more compute units than its limit.', category: 'compute', advice: ['Simulate the transaction, read its unitsConsumed, and set the compute-unit limit about 15% above it.', 'A transaction with no compute-budget instruction gets 200,000 units per instruction; heavy instructions need more.'] },
  InsufficientFunds: { text: 'An account did not have enough lamports (or tokens) for the instruction.', category: 'balance', advice: ['Check the balance of the paying account, including rent for any account the instruction creates.'] },
  MissingRequiredSignature: { text: 'An account that must sign the transaction did not.', category: 'authority', advice: ['Make sure every required signer signed, and that the signer is the account the instruction names.'] },
  InvalidAccountData: { text: 'An account holds data the program cannot read.', category: 'account', advice: ['The account may be the wrong kind, uninitialised, or from an older layout of the program. Check its address and owner.'] },
  UninitializedAccount: { text: 'An account the instruction needs has not been initialised.', category: 'account', advice: ['Create or initialise the account first (for a token account, the associated token account instruction).'] },
  AccountAlreadyInitialized: { text: 'The account is already initialised.', category: 'account', advice: ['The instruction is creating something that exists. Read the account before creating it.'] },
  IncorrectProgramId: { text: 'An instruction was sent to, or referenced, the wrong program.', category: 'account', advice: ['Check the program ids in the instruction and its accounts.'] },
  InvalidArgument: { text: 'An argument to the instruction is not valid.', category: 'program-rule', advice: ['Check the instruction data against the program\'s interface.'] },
  InvalidInstructionData: { text: 'The instruction data could not be understood.', category: 'program-rule', advice: ['The client and the deployed program disagree about the instruction layout: update the client to the deployed program version.'] },
  AccountNotRentExempt: { text: 'An account would be left below the rent-exempt minimum.', category: 'balance', advice: ['Fund the account with the rent-exempt minimum for its size.'] },
  InsufficientFundsForRent: { text: 'The transaction would leave an account below the rent-exempt minimum.', category: 'balance', advice: ['Leave at least the rent-exempt minimum in every account the transaction touches.'] },
  ArithmeticOverflow: { text: 'An arithmetic operation overflowed.', category: 'math', advice: ['An amount is outside the range the program accepts; check units and decimals.'] },
  IncorrectAuthority: { text: 'The signer is not the authority the account requires.', category: 'authority', advice: ['Sign with the authority recorded on the account.'] },
  PrivilegeEscalation: { text: 'A called program was given a signer or writable privilege its caller did not have.', category: 'authority', advice: ['An account is marked writable or signer in the inner call but not in the outer instruction.'] },
  ProgramFailedToComplete: { text: 'The program ran out of memory, stack or compute and was stopped.', category: 'compute', advice: ['Raise the compute-unit limit; if it still fails the instruction is too large for one transaction.'] },
  AccountDataTooSmall: { text: 'An account is too small for the data the instruction writes.', category: 'account', advice: ['The account was created with an older, smaller layout.'] },
  InvalidSeeds: { text: 'The seeds given do not produce the address expected.', category: 'account', advice: ['Derive the address with the same seeds and program id the program uses.'] },
  InvalidAccountOwner: { text: 'An account is owned by a different program than the instruction expects.', category: 'account', advice: ['Check you passed the right account and that it belongs to the program named in the logs.'] },
};

const TRANSACTION: Record<string, { text: string; category: Category; advice: string[] }> = {
  BlockhashNotFound: { text: 'The transaction\'s blockhash is too old, or the node has not seen it yet.', category: 'blockhash', advice: ['Rebuild the transaction with a fresh blockhash and send it again; an expired transaction cannot land.', 'If the blockhash is fresh, the node you asked lags the cluster: send through another endpoint.'] },
  AlreadyProcessed: { text: 'This exact transaction already landed.', category: 'state', advice: ['Look the signature up; the work is probably done.'] },
  InsufficientFundsForFee: { text: 'The fee payer cannot pay the network fee.', category: 'balance', advice: ['Add SOL to the fee payer.'] },
  AccountNotFound: { text: 'The fee payer account does not exist on this cluster.', category: 'balance', advice: ['The wallet has never held SOL here. On devnet, request an airdrop first.'] },
  ProgramAccountNotFound: { text: 'A program the transaction calls is not deployed on this cluster.', category: 'account', advice: ['Check the cluster and the program id.'] },
  SignatureFailure: { text: 'A signature on the transaction is not valid.', category: 'authority', advice: ['The transaction was changed after it was signed, or signed by the wrong key.'] },
  InvalidAccountForFee: { text: 'The fee payer account cannot pay fees.', category: 'balance', advice: ['The fee payer must be a system-owned account with enough SOL.'] },
  AccountInUse: { text: 'An account is locked by another transaction in the same block.', category: 'network', advice: ['Wait a moment and send again.'] },
  WouldExceedMaxBlockCostLimit: { text: 'The block was full for the accounts this transaction touches.', category: 'network', advice: ['Resend with a higher priority fee.'] },
  TooManyAccountLocks: { text: 'The transaction touches too many accounts.', category: 'program-rule', advice: ['Split it into two transactions.'] },
  AddressLookupTableNotFound: { text: 'An address lookup table the transaction uses does not exist.', category: 'account', advice: ['Check the table address and the cluster.'] },
};

const CATEGORY_RULES: [RegExp, Category][] = [
  // Names by which swap programs say the output fell short of the minimum the caller set: all are slippage.
  [/slippage|toolittleoutput|minreturn|insufficientoutamount|minimumout|minoutput/i, 'slippage'],
  [/insufficient|notrentexempt|rent/i, 'balance'],
  [/overflow|math|underflow|divisionbyzero/i, 'math'],
  [/unauthori|notauthori|invalidauthority|notapproved|signer|owner(?!ship)|admin|operator|creator|authority/i, 'authority'],
  [/notinitialized|uninitialized|accountnot|invalidaccount|constraint(?!signer)|accountowned|invalidprogram|seeds|addressmismatch|mismatch/i, 'account'],
  [/pause|halt|notstarted|ended|closed|expired|already|migrat|notready|finished|completed|state|window|deadline/i, 'state'],
];

function categorise(name: string): Category {
  for (const [re, c] of CATEGORY_RULES) if (re.test(name)) return c;
  return 'program-rule';
}

const ADVICE: Partial<Record<Category, string[]>> = {
  slippage: [
    'The price moved past your limit between the quote and the moment the transaction ran, or the limit was set too tight for how fast this market moves.',
    'Get a fresh quote, then either raise the slippage tolerance to what you would accept or send sooner (a higher priority fee). Nothing was traded.',
  ],
  balance: ['Check that the paying account holds the amount, plus the network fee and any rent for accounts the instruction creates.'],
  account: ['Check the accounts passed to the instruction: addresses, owners, and that each exists and is initialised.'],
  authority: ['Check which key is required to sign and that it is the one that signed.'],
  state: ['The instruction is not allowed in the current state of the market or account. Read its state, and try again when it permits it.'],
  math: ['An amount is outside what the program can compute. Check the units, decimals and sizes.'],
  'program-rule': ['The program refused the instruction under one of its own rules; the message names the rule.'],
};

const FOOTER = 'A failed transaction changes nothing on chain except the network fee, which is still charged.';

function programRef(address: string | null) {
  if (!address) return null;
  const t = table(address);
  return { address, name: t?.name ?? address, label: t?.label ?? 'an unlisted program' };
}

function parseCode(reason: string, err: unknown): number | null {
  const m = /custom program error: (0x[0-9a-fA-F]+)/.exec(reason);
  if (m) return Number.parseInt(m[1]!, 16);
  const e = err as { InstructionError?: [number, unknown] } | null;
  const d = e?.InstructionError?.[1] as { Custom?: number } | string | undefined;
  return d && typeof d === 'object' && typeof d.Custom === 'number' ? d.Custom : null;
}

/** Turns a failed transaction (its error and logs) into a diagnosis. Never throws on odd input: an error it cannot place is reported as unmapped, with the evidence. */
export function diagnose(tx: FailedTransaction): Diagnosis {
  const logs = tx.logs ?? [];
  const found = failingFrame(logs);
  const ie = (tx.err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const index = found?.frame.top ?? (Array.isArray(ie) ? Number(ie[0]) : null);
  const programId = found?.frame.program ?? (index !== null ? (tx.instructionPrograms?.[index] ?? null) : null);
  const where: Diagnosis['where'] = { instructionIndex: index, program: programRef(programId), callDepth: found?.frame.depth ?? null, instruction: found?.frame.instruction ?? null };
  const evidence = found ? found.frame.lines.filter((l) => /failed|AnchorError|Instruction:|custom program error/.test(l)).slice(-4) : [];
  const programLog = found?.frame.anchor ?? null;

  // 1. A transaction-level failure with no instruction involved.
  const errName = typeof tx.err === 'string' ? tx.err : tx.err && typeof tx.err === 'object' ? Object.keys(tx.err as object)[0] : undefined;
  if (!ie && errName && TRANSACTION[errName]) {
    const t = TRANSACTION[errName]!;
    return { summary: t.text, category: t.category, where, error: { source: 'transaction', code: null, name: errName, message: t.text, table: null }, programLog: null, tableAgreesWithProgram: null, advice: [...t.advice, FOOTER], evidence: [] };
  }

  // 2. A custom program error: look the code up.
  const code = found ? parseCode(found.reason, tx.err) : parseCode('', tx.err);
  if (code !== null) {
    const framework = code < 6000 ? ANCHOR_FRAMEWORK[code] : undefined;
    const prog = programId ? table(programId) : undefined;
    const own = prog?.errors[code];
    const hit = framework ?? own;
    const source: Diagnosis['error']['source'] = framework ? 'anchor-framework' : own ? 'program' : programLog ? 'program-log' : 'unmapped';
    const name = hit?.[0] ?? programLog?.name ?? null;
    const message = hit?.[1] ?? programLog?.message ?? null;
    const tableName = hit?.[0] ?? null;
    const agrees = programLog && tableName ? programLog.name === tableName && programLog.number === code : null;
    const category = name ? categorise(name) : 'unknown';
    const advice = [...(ADVICE[category] ?? [])];
    if (agrees === false) advice.unshift(`The IDL on file for ${prog?.label ?? 'this program'} (${prog?.version ?? 'unknown version'}) names code ${code} "${tableName}", but the program logged "${programLog!.name}" (${programLog!.number}). The deployed program is newer than the IDL; trust the program's own log.`);
    if (source === 'unmapped') advice.unshift(`Error code ${code} is not in any table this tool has for ${where.program?.label ?? 'this program'}. Look it up in that program's source or IDL.`);
    const who = where.program && where.program.label !== 'an unlisted program' ? where.program.label : programId ? `program ${programId.slice(0, 8)}…` : 'a program';
    const doing = where.instruction ? ` while running ${where.instruction}` : '';
    const summary = name ? `${who} refused the transaction${doing}: ${name}${message ? ` (${message})` : ''}.` : `${who} failed with error code ${code}${doing}.`;
    return {
      summary,
      category,
      where,
      error: { source, code, name, message, table: source === 'anchor-framework' ? { label: 'Anchor framework', version: ANCHOR_VERSION, source: 'anchor/lang/error' } : prog && own ? { label: prog.label, version: prog.version, source: prog.source } : null },
      programLog,
      tableAgreesWithProgram: agrees,
      advice: [...advice, FOOTER],
      evidence,
    };
  }

  // 3. A runtime error with a name, such as ComputationalBudgetExceeded.
  const detail = Array.isArray(ie) ? ie[1] : null;
  const runtimeName = typeof detail === 'string' ? detail : detail && typeof detail === 'object' ? Object.keys(detail as object)[0] : undefined;
  const reasonName = found ? Object.keys(RUNTIME).find((k) => found.reason.toLowerCase().includes(k.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2'))) : undefined;
  const key = runtimeName && RUNTIME[runtimeName] ? runtimeName : reasonName;
  if (key) {
    const r = RUNTIME[key]!;
    const who = where.program && where.program.label !== 'an unlisted program' ? ` in ${where.program.label}` : '';
    return { summary: `${r.text.replace(/\.$/, '')}${who}.`, category: r.category, where, error: { source: 'runtime', code: null, name: key, message: r.text, table: null }, programLog, tableAgreesWithProgram: null, advice: [...r.advice, FOOTER], evidence };
  }
  if (found && /exceeded CUs meter|Computational budget exceeded|exceeded maximum number of instructions/i.test(found.reason)) {
    const r = RUNTIME.ComputationalBudgetExceeded!;
    return { summary: r.text, category: 'compute', where, error: { source: 'runtime', code: null, name: 'ComputationalBudgetExceeded', message: r.text, table: null }, programLog, tableAgreesWithProgram: null, advice: [...r.advice, FOOTER], evidence };
  }

  return {
    summary: found ? `${where.program?.label ?? 'A program'} failed: ${found.reason}.` : 'The transaction failed, and the error given does not say where.',
    category: 'unknown',
    where,
    error: { source: 'unmapped', code: null, name: runtimeName ?? errName ?? null, message: found?.reason ?? null, table: null },
    programLog,
    tableAgreesWithProgram: null,
    advice: ['Read the program logs of the transaction; the lines above are the ones nearest the failure.', FOOTER],
    evidence,
  };
}

/** The tables this package holds, for a caller that wants to show which programs it can explain. */
export function knownPrograms(): { address: string; name: string; label: string; version: string | null; errors: number }[] {
  return PROGRAMS.map((p) => ({ address: p.address, name: p.name, label: p.label, version: p.version, errors: Object.keys(p.errors).length }));
}

/** The name and message for a custom error code of a program, or null. */
export function lookupError(programAddress: string, code: number): { name: string; message: string; source: string } | null {
  const fw = code < 6000 ? ANCHOR_FRAMEWORK[code] : undefined;
  if (fw) return { name: fw[0], message: fw[1], source: 'anchor-framework' };
  const t = table(programAddress)?.errors[code];
  return t ? { name: t[0], message: t[1], source: table(programAddress)!.source } : null;
}
