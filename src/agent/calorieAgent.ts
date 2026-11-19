import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.ts';

export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type AgentStatus = 'DONE' | 'NEEDS_HUMAN';
export type ApprovalDecision = 'approved' | 'rejected' | 'invalid';

export interface NutritionEstimate {
  itemName: string;
  calories: number;
  carbs: number;
  protein: number;
  confidence: ConfidenceLevel;
  portionAssumed: string;
  isFoodOrDrink: boolean;
  imageQualityOk: boolean;
  qualityIssue?: string;
  detectedPromptInjection?: string;
}

export interface MealLogEntry {
  id: string;
  date: string;
  timestamp: string;
  photoRef: string;
  itemName: string;
  portionAssumed: string;
  estimatedCalories: number;
  estimatedCarbs: number;
  estimatedProtein: number;
  finalCalories: number;
  finalCarbs: number;
  finalProtein: number;
  confidence: ConfidenceLevel;
  editedByUser: boolean;
  entryType?: 'meal' | 'snack';
  isEstimate: true;
}

export interface BurnLogEntry {
  id: string;
  date: string;
  timestamp: string;
  source: string;
  calories: number;
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  date: string;
  action: 'scan' | 'log' | 'delete' | 'goal' | 'burn';
  status: AgentStatus;
  photoRef?: string;
  estimated?: {
    itemName: string;
    calories: number;
    carbs: number;
    protein: number;
    confidence: ConfidenceLevel;
    portionAssumed: string;
  };
  approved?: boolean;
  edited?: boolean;
  finalValues?: {
    itemName: string;
    calories: number;
    carbs: number;
    protein: number;
    portionAssumed: string;
  };
  deletedMealId?: string;
  failedChecks?: string[];
  ignoredInjectionText?: string;
  note?: string;
}

export interface DailyStore {
  dailyCalorieGoal: number;
  dailyProteinGoal: number;
  meals: MealLogEntry[];
  burns: BurnLogEntry[];
}

export interface StagedPhoto {
  token: string;
  photoRef: string;
  mimeType: string;
  base64Data: string;
  byteLength: number;
  caption: string;
  ignoredInjectionText?: string;
  stagedAt: string;
}

export interface ScanResult {
  status: AgentStatus;
  attempts: number;
  retriesUsed: number;
  estimate?: NutritionEstimate;
  failedChecks: string[];
  message: string;
  ignoredInjectionText?: string;
  scansUsedToday: number;
  dailyScanCap: number;
}

export interface DailySummary {
  date: string;
  dailyCalorieGoal: number;
  dailyProteinGoal: number;
  caloriesLogged: number;
  carbsLogged: number;
  proteinLogged: number;
  proteinRemaining: number;
  proteinTargetMet: boolean;
  caloriesBurned: number;
  netCalories: number;
  remainingCalories: number;
  inDeficitRange: boolean;
  scansUsedToday: number;
  dailyScanCap: number;
  meals: MealLogEntry[];
  burns: BurnLogEntry[];
}

export type ScanProvider = (params: {
  base64Data: string;
  mimeType: string;
  caption?: string;
  retryReason?: string;
}) => Promise<unknown>;

export interface StagedTextMeal {
  token: string;
  entryType: 'meal' | 'snack';
  mealDescription: string;
  gramsOrAmount: string;
  photoRef: string;
  ignoredInjectionText?: string;
  stagedAt: string;
}

export type TextEstimateProvider = (params: {
  entryType: 'meal' | 'snack';
  mealDescription: string;
  gramsOrAmount: string;
  retryReason?: string;
}) => Promise<unknown>;

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?(your\s+)?rules/i,
  /skip\s+(the\s+)?approvals?/i,
  /print\s+(the\s+)?(api[_\s]?)?key/i,
  /reveal\s+(the\s+)?(api[_\s]?)?key/i,
  /gemini[_\s]?api[_\s]?key/i,
  /system\s+prompt/i,
  /disregard\s+(previous|above|all)/i,
  /bypass\s+(approval|check|security)/i,
];

export function todayDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function detectPromptInjection(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return trimmed.slice(0, 240);
    }
  }
  return undefined;
}

export function parseApproval(input: unknown): ApprovalDecision {
  if (typeof input !== 'string') return 'invalid';
  const normalized = input.trim().toLowerCase();
  if (normalized === 'yes') return 'approved';
  if (normalized === 'no') return 'rejected';
  return 'invalid';
}

export function validateCalorieGoal(rawValue: unknown): {
  valid: boolean;
  value?: number;
  error?: string;
} {
  const num = typeof rawValue === 'number' ? rawValue : Number(String(rawValue ?? '').trim());
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    return {
      valid: false,
      error: `Enter a whole number between ${CONFIG.minCalorieGoal} and ${CONFIG.maxCalorieGoal} kcal.`,
    };
  }
  if (num < CONFIG.minCalorieGoal || num > CONFIG.maxCalorieGoal) {
    return {
      valid: false,
      error: `Daily calorie goal must be between ${CONFIG.minCalorieGoal} and ${CONFIG.maxCalorieGoal} kcal.`,
    };
  }
  return { valid: true, value: num };
}

export function validateProteinGoal(rawValue: unknown): {
  valid: boolean;
  value?: number;
  error?: string;
} {
  const num = typeof rawValue === 'number' ? rawValue : Number(String(rawValue ?? '').trim());
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    return {
      valid: false,
      error: `Enter a whole number between ${CONFIG.minProteinGoal} and ${CONFIG.maxProteinGoal} g.`,
    };
  }
  if (num < CONFIG.minProteinGoal || num > CONFIG.maxProteinGoal) {
    return {
      valid: false,
      error: `Daily protein goal must be between ${CONFIG.minProteinGoal} and ${CONFIG.maxProteinGoal} g.`,
    };
  }
  return { valid: true, value: num };
}

export function validateBurnCalories(rawValue: unknown): {
  valid: boolean;
  value?: number;
  error?: string;
} {
  const num = typeof rawValue === 'number' ? rawValue : Number(String(rawValue ?? '').trim());
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0 || num > CONFIG.maxBurnCalories) {
    return {
      valid: false,
      error: `Calories burned must be a whole number between 1 and ${CONFIG.maxBurnCalories} kcal.`,
    };
  }
  return { valid: true, value: num };
}

export function resolveSafeDataFile(dataDir: string, fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('Unsafe file path rejected.');
  }
  if (
    fileName.includes('..') ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    throw new Error('Unsafe file path rejected.');
  }
  const baseDir = path.resolve(dataDir);
  const target = path.resolve(baseDir, fileName);
  const relative = path.relative(baseDir, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Unsafe file path rejected.');
  }
  return target;
}

export function validateImageMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 12) return false;
  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

export function validateUploadInput(params: {
  filename: unknown;
  mimeType: unknown;
  base64Data: unknown;
  caption?: unknown;
}): {
  valid: boolean;
  error?: string;
  sanitizedFilename?: string;
  mimeType?: string;
  base64Data?: string;
  byteLength?: number;
  caption?: string;
  ignoredInjectionText?: string;
} {
  const { filename, mimeType, base64Data, caption } = params;

  if (typeof filename !== 'string' || !filename.trim()) {
    return { valid: false, error: 'Please select a photo of your meal or drink first.' };
  }

  const trimmedName = filename.trim();
  if (
    trimmedName.includes('..') ||
    trimmedName.includes('/') ||
    trimmedName.includes('\\') ||
    trimmedName.includes('\0')
  ) {
    return { valid: false, error: 'Unsafe filename rejected. Rename the image and try again.' };
  }

  const ext = path.extname(trimmedName).toLowerCase();
  if (!CONFIG.allowedExtensions.includes(ext)) {
    return {
      valid: false,
      error: `Only JPEG, PNG, or WebP food photos are supported (${CONFIG.allowedExtensions.join(', ')}).`,
    };
  }

  if (typeof mimeType !== 'string' || !CONFIG.allowedMimeTypes.includes(mimeType)) {
    return {
      valid: false,
      error: 'Unsupported file type. Upload a JPEG, PNG, or WebP photo of food or drink.',
    };
  }

  if (typeof base64Data !== 'string' || !base64Data.trim()) {
    return { valid: false, error: 'The uploaded file is empty. Please choose a clear meal photo.' };
  }

  const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanBase64 || !/^[A-Za-z0-9+/=]+$/.test(cleanBase64)) {
    return { valid: false, error: 'Invalid image data. Please upload a JPEG, PNG, or WebP photo.' };
  }

  const buffer = Buffer.from(cleanBase64, 'base64');
  if (buffer.length === 0) {
    return { valid: false, error: 'The uploaded file is empty. Please choose a clear meal photo.' };
  }

  if (buffer.length > CONFIG.maxImageBytes) {
    const limitMb = (CONFIG.maxImageBytes / (1024 * 1024)).toFixed(0);
    return {
      valid: false,
      error: `Photo exceeds the ${limitMb} MB size limit. Please upload a smaller image.`,
    };
  }

  if (!validateImageMagicBytes(buffer, mimeType)) {
    return {
      valid: false,
      error: 'File contents do not match a valid JPEG, PNG, or WebP image.',
    };
  }

  const cleanCaption = typeof caption === 'string' ? caption.trim().slice(0, 200) : '';
  const filenameInjection = detectPromptInjection(trimmedName);
  const captionInjection = detectPromptInjection(cleanCaption);
  const ignoredInjectionText = filenameInjection || captionInjection;

  const safeBaseName = path.basename(trimmedName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);

  return {
    valid: true,
    sanitizedFilename: safeBaseName,
    mimeType,
    base64Data: cleanBase64,
    byteLength: buffer.length,
    caption: cleanCaption,
    ignoredInjectionText,
  };
}

export function validateTextMealInput(params: {
  entryType: unknown;
  mealDescription: unknown;
  gramsOrAmount: unknown;
}): {
  valid: boolean;
  error?: string;
  entryType?: 'meal' | 'snack';
  mealDescription?: string;
  gramsOrAmount?: string;
  ignoredInjectionText?: string;
} {
  const entryType = params.entryType === 'snack' ? 'snack' : 'meal';
  const rawMeal = typeof params.mealDescription === 'string' ? params.mealDescription.trim() : '';
  const rawGrams = typeof params.gramsOrAmount === 'string' ? params.gramsOrAmount.trim() : '';

  if (!rawMeal) {
    return {
      valid: false,
      error:
        entryType === 'snack'
          ? 'Please enter what the snack is (e.g. almonds or protein bar).'
          : 'Please enter what the meal is (e.g. chicken and rice).',
    };
  }

  if (!rawGrams) {
    return {
      valid: false,
      error:
        entryType === 'snack'
          ? 'Please enter the weight in grams or portion (e.g. 30g or 1 bar).'
          : 'Please enter the weight in grams (e.g. 200g chicken, 150g rice).',
    };
  }

  if (/(^|\s)-\d+/.test(rawGrams)) {
    return {
      valid: false,
      error: 'Gram or portion amount cannot be negative.',
    };
  }

  const mealDescription = rawMeal.slice(0, 180);
  const gramsOrAmount = rawGrams.slice(0, 120);
  const ignoredInjectionText =
    detectPromptInjection(mealDescription) || detectPromptInjection(gramsOrAmount);

  return {
    valid: true,
    entryType,
    mealDescription,
    gramsOrAmount,
    ignoredInjectionText,
  };
}

export function validateNutritionEstimate(raw: unknown): {
  valid: boolean;
  estimate?: NutritionEstimate;
  failedChecks: string[];
  stopImmediately: boolean;
  detectedPromptInjection?: string;
} {
  const failedChecks: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      failedChecks: ['Response was not a structured JSON object.'],
      stopImmediately: false,
    };
  }

  const obj = raw as Record<string, unknown>;
  const modelInjection =
    typeof obj.detectedPromptInjection === 'string' && obj.detectedPromptInjection.trim()
      ? obj.detectedPromptInjection.trim().slice(0, 240)
      : undefined;

  if (obj.isFoodOrDrink !== true) {
    return {
      valid: false,
      failedChecks: ['Photo does not clearly show food or drink.'],
      stopImmediately: true,
      detectedPromptInjection: modelInjection,
    };
  }

  if (obj.imageQualityOk !== true) {
    const reason =
      typeof obj.qualityIssue === 'string' && obj.qualityIssue.trim()
        ? obj.qualityIssue.trim()
        : 'Photo is too blurry or dark. Please take a clearer photo.';
    return {
      valid: false,
      failedChecks: [reason],
      stopImmediately: true,
      detectedPromptInjection: modelInjection,
    };
  }

  const itemName = typeof obj.itemName === 'string' ? obj.itemName.trim() : '';
  if (!itemName) {
    failedChecks.push('Missing required field: itemName.');
  }

  const portionAssumed = typeof obj.portionAssumed === 'string' ? obj.portionAssumed.trim() : '';
  if (!portionAssumed) {
    failedChecks.push('Missing required field: portionAssumed.');
  }

  const confidence = obj.confidence;
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
    failedChecks.push('Missing or invalid confidence level.');
  } else if (confidence === 'low') {
    failedChecks.push('Confidence is low; refusing to guess nutrition values.');
  }

  const calories = obj.calories;
  const carbs = obj.carbs;
  const protein = obj.protein;

  if (typeof calories !== 'number' || !Number.isFinite(calories)) {
    failedChecks.push('Missing required numeric field: calories.');
  } else if (calories < 0 || calories > CONFIG.maxSingleMealCalories) {
    failedChecks.push(`Calories must be between 0 and ${CONFIG.maxSingleMealCalories}.`);
  }

  if (typeof carbs !== 'number' || !Number.isFinite(carbs)) {
    failedChecks.push('Missing required numeric field: carbs.');
  } else if (carbs < 0 || carbs > CONFIG.maxMacroGrams) {
    failedChecks.push(`Carbs must be between 0 and ${CONFIG.maxMacroGrams}g.`);
  }

  if (typeof protein !== 'number' || !Number.isFinite(protein)) {
    failedChecks.push('Missing required numeric field: protein.');
  } else if (protein < 0 || protein > CONFIG.maxMacroGrams) {
    failedChecks.push(`Protein must be between 0 and ${CONFIG.maxMacroGrams}g.`);
  }

  if (
    typeof calories === 'number' &&
    Number.isFinite(calories) &&
    calories >= 0 &&
    typeof carbs === 'number' &&
    Number.isFinite(carbs) &&
    carbs >= 0 &&
    typeof protein === 'number' &&
    Number.isFinite(protein) &&
    protein >= 0
  ) {
    const minCaloriesFromMacros = 4 * carbs + 4 * protein;
    if (calories === 0 && (carbs > 0 || protein > 0)) {
      failedChecks.push('Macro grams are positive while stated calories are 0.');
    } else if (
      minCaloriesFromMacros >
      calories * (1 + CONFIG.macroCalorieToleranceRatio) + CONFIG.macroCalorieTolerancePadding
    ) {
      failedChecks.push(
        `Macros (4*carbs + 4*protein = ${Math.round(minCaloriesFromMacros)} kcal) exceed stated calories (${Math.round(calories)} kcal).`,
      );
    }
  }

  if (failedChecks.length > 0) {
    return {
      valid: false,
      failedChecks,
      stopImmediately: false,
      detectedPromptInjection: modelInjection,
    };
  }

  return {
    valid: true,
    failedChecks: [],
    stopImmediately: false,
    detectedPromptInjection: modelInjection,
    estimate: {
      itemName,
      calories: Math.round(calories as number),
      carbs: Math.round(carbs as number),
      protein: Math.round(protein as number),
      confidence: confidence as ConfidenceLevel,
      portionAssumed,
      isFoodOrDrink: true,
      imageQualityOk: true,
      detectedPromptInjection: modelInjection,
    },
  };
}

export function sanitizeToolErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  if (/GEMINI_API_KEY|API_KEY_INVALID|missing.*key|401|403/i.test(msg)) {
    return 'Gemini API key is missing or invalid. Check GEMINI_API_KEY in .env and try again.';
  }
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
    return 'Free-tier API quota reached. Try again later or check your daily limit.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|fetch failed/i.test(msg)) {
    return 'No network connection to Gemini API. Check your internet connection and try again.';
  }
  if (/EACCES|EPERM|EROFS|read-only|not writable/i.test(msg)) {
    return 'Log file is not writable or read-only. Check permissions for the output/ directory.';
  }
  return 'The scan could not be completed. Please try again with a clearer photo or enter values manually.';
}

export class LocalStore {
  private readonly dataDir: string;

  constructor(dataDir: string = CONFIG.dataDir) {
    this.dataDir = path.resolve(dataDir);
  }

  private get logsPath(): string {
    return resolveSafeDataFile(this.dataDir, CONFIG.logsFileName);
  }

  private get recordsPath(): string {
    return resolveSafeDataFile(this.dataDir, CONFIG.recordsFileName);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  private cutoffDate(now: Date = new Date()): string {
    const cutoff = new Date(now.getTime() - CONFIG.retentionDays * 24 * 60 * 60 * 1000);
    return cutoff.toISOString().slice(0, 10);
  }

  readStore(now: Date = new Date()): DailyStore {
    this.ensureDir();
    if (!fs.existsSync(this.logsPath)) {
      return {
        dailyCalorieGoal: CONFIG.defaultDailyCalorieGoal,
        dailyProteinGoal: CONFIG.defaultDailyProteinGoal,
        meals: [],
        burns: [],
      };
    }
    const raw = fs.readFileSync(this.logsPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DailyStore>;
    const cutoff = this.cutoffDate(now);
    return {
      dailyCalorieGoal:
        typeof parsed.dailyCalorieGoal === 'number' && parsed.dailyCalorieGoal > 0
          ? parsed.dailyCalorieGoal
          : CONFIG.defaultDailyCalorieGoal,
      dailyProteinGoal:
        typeof parsed.dailyProteinGoal === 'number' && parsed.dailyProteinGoal > 0
          ? parsed.dailyProteinGoal
          : CONFIG.defaultDailyProteinGoal,
      meals: Array.isArray(parsed.meals)
        ? parsed.meals.filter((m) => typeof m?.date === 'string' && m.date >= cutoff)
        : [],
      burns: Array.isArray(parsed.burns)
        ? parsed.burns.filter((b) => typeof b?.date === 'string' && b.date >= cutoff)
        : [],
    };
  }

  writeStore(store: DailyStore, now: Date = new Date()): void {
    this.ensureDir();
    const cutoff = this.cutoffDate(now);
    const pruned: DailyStore = {
      dailyCalorieGoal: store.dailyCalorieGoal,
      dailyProteinGoal: store.dailyProteinGoal,
      meals: store.meals.filter((m) => m.date >= cutoff),
      burns: store.burns.filter((b) => b.date >= cutoff),
    };
    try {
      fs.writeFileSync(this.logsPath, JSON.stringify(pruned, null, 2), 'utf8');
    } catch (err) {
      throw new Error(sanitizeToolErrorMessage(err));
    }
  }

  readRecords(now: Date = new Date()): AuditRecord[] {
    this.ensureDir();
    if (!fs.existsSync(this.recordsPath)) {
      return [];
    }
    const raw = fs.readFileSync(this.recordsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const cutoff = this.cutoffDate(now);
    return Array.isArray(parsed)
      ? parsed.filter((r) => typeof r?.date === 'string' && r.date >= cutoff)
      : [];
  }

  appendRecord(record: AuditRecord, now: Date = new Date()): void {
    this.ensureDir();
    const records = this.readRecords(now);
    records.push(record);
    const cutoff = this.cutoffDate(now);
    const pruned = records.filter((r) => r.date >= cutoff);
    try {
      fs.writeFileSync(this.recordsPath, JSON.stringify(pruned, null, 2), 'utf8');
    } catch (err) {
      throw new Error(sanitizeToolErrorMessage(err));
    }
  }

  countScansToday(now: Date = new Date()): number {
    const today = todayDateString(now);
    return this.readRecords(now).filter(
      (r) => r.date === today && r.action === 'scan' && r.note !== 'blocked_at_cap',
    ).length;
  }

  setGoal(goalInput: unknown, now: Date = new Date()): { ok: boolean; error?: string; goal?: number } {
    const check = validateCalorieGoal(goalInput);
    if (!check.valid || check.value === undefined) {
      return { ok: false, error: check.error };
    }
    const store = this.readStore(now);
    store.dailyCalorieGoal = check.value;
    this.writeStore(store, now);
    this.appendRecord(
      {
        id: crypto.randomUUID(),
        timestamp: now.toISOString(),
        date: todayDateString(now),
        action: 'goal',
        status: 'DONE',
        note: `Daily calorie goal set to ${check.value} kcal.`,
      },
      now,
    );
    return { ok: true, goal: check.value };
  }

  setProteinGoal(
    goalInput: unknown,
    now: Date = new Date(),
  ): { ok: boolean; error?: string; goal?: number } {
    const check = validateProteinGoal(goalInput);
    if (!check.valid || check.value === undefined) {
      return { ok: false, error: check.error };
    }
    const store = this.readStore(now);
    store.dailyProteinGoal = check.value;
    this.writeStore(store, now);
    this.appendRecord(
      {
        id: crypto.randomUUID(),
        timestamp: now.toISOString(),
        date: todayDateString(now),
        action: 'goal',
        status: 'DONE',
        note: `Daily protein goal set to ${check.value} g.`,
      },
      now,
    );
    return { ok: true, goal: check.value };
  }

  addBurn(
    caloriesInput: unknown,
    sourceInput: unknown,
    now: Date = new Date(),
  ): { ok: boolean; error?: string; entry?: BurnLogEntry } {
    const check = validateBurnCalories(caloriesInput);
    if (!check.valid || check.value === undefined) {
      return { ok: false, error: check.error };
    }
    const source =
      typeof sourceInput === 'string' && sourceInput.trim()
        ? sourceInput.trim().slice(0, 80)
        : 'Gym / Watch';

    const store = this.readStore(now);
    const entry: BurnLogEntry = {
      id: crypto.randomUUID(),
      date: todayDateString(now),
      timestamp: now.toISOString(),
      source,
      calories: check.value,
    };
    store.burns.push(entry);
    this.writeStore(store, now);
    this.appendRecord(
      {
        id: crypto.randomUUID(),
        timestamp: now.toISOString(),
        date: todayDateString(now),
        action: 'burn',
        status: 'DONE',
        note: `Logged ${entry.calories} kcal burned (${source}).`,
      },
      now,
    );
    return { ok: true, entry };
  }

  addMealEntry(params: {
    approvalText: unknown;
    photoRef: string;
    estimated: {
      itemName: string;
      calories: number;
      carbs: number;
      protein: number;
      confidence: ConfidenceLevel;
      portionAssumed: string;
    };
    editedValues?: {
      itemName?: unknown;
      calories?: unknown;
      carbs?: unknown;
      protein?: unknown;
      portionAssumed?: unknown;
    };
    entryType?: 'meal' | 'snack';
    ignoredInjectionText?: string;
    now?: Date;
  }): { ok: boolean; discarded?: boolean; error?: string; entry?: MealLogEntry } {
    const now = params.now ?? new Date();
    const decision = parseApproval(params.approvalText);

    if (decision === 'invalid') {
      return {
        ok: false,
        error: 'Approval required: type "yes" to save to today\'s log, or "no" to discard.',
      };
    }

    if (decision === 'rejected') {
      this.appendRecord(
        {
          id: crypto.randomUUID(),
          timestamp: now.toISOString(),
          date: todayDateString(now),
          action: 'log',
          status: 'DONE',
          photoRef: params.photoRef,
          estimated: params.estimated,
          approved: false,
          edited: false,
          ignoredInjectionText: params.ignoredInjectionText,
          note: 'User discarded scan before logging.',
        },
        now,
      );
      return { ok: true, discarded: true };
    }

    if (
      !params.estimated ||
      typeof params.estimated !== 'object' ||
      typeof params.estimated.itemName !== 'string' ||
      typeof params.estimated.portionAssumed !== 'string'
    ) {
      return {
        ok: false,
        error: 'No nutrition estimate is ready to log.',
      };
    }

    const finalItemName =
      typeof params.editedValues?.itemName === 'string' && params.editedValues.itemName.trim()
        ? params.editedValues.itemName.trim().slice(0, 120)
        : params.estimated.itemName;

    const finalPortion =
      typeof params.editedValues?.portionAssumed === 'string' &&
      params.editedValues.portionAssumed.trim()
        ? params.editedValues.portionAssumed.trim().slice(0, 120)
        : params.estimated.portionAssumed;

    const finalCalories =
      params.editedValues?.calories !== undefined
        ? Number(params.editedValues.calories)
        : params.estimated.calories;
    const finalCarbs =
      params.editedValues?.carbs !== undefined
        ? Number(params.editedValues.carbs)
        : params.estimated.carbs;
    const finalProtein =
      params.editedValues?.protein !== undefined
        ? Number(params.editedValues.protein)
        : params.estimated.protein;

    if (
      !Number.isFinite(finalCalories) ||
      finalCalories < 0 ||
      finalCalories > CONFIG.maxSingleMealCalories ||
      !Number.isFinite(finalCarbs) ||
      finalCarbs < 0 ||
      finalCarbs > CONFIG.maxMacroGrams ||
      !Number.isFinite(finalProtein) ||
      finalProtein < 0 ||
      finalProtein > CONFIG.maxMacroGrams
    ) {
      return {
        ok: false,
        error: 'Edited nutrition values must be valid non-negative numbers within meal limits.',
      };
    }

    const editedByUser =
      Math.round(finalCalories) !== params.estimated.calories ||
      Math.round(finalCarbs) !== params.estimated.carbs ||
      Math.round(finalProtein) !== params.estimated.protein ||
      finalPortion !== params.estimated.portionAssumed ||
      finalItemName !== params.estimated.itemName;

    const entry: MealLogEntry = {
      id: crypto.randomUUID(),
      date: todayDateString(now),
      timestamp: now.toISOString(),
      photoRef: params.photoRef,
      itemName: finalItemName,
      portionAssumed: finalPortion,
      estimatedCalories: params.estimated.calories,
      estimatedCarbs: params.estimated.carbs,
      estimatedProtein: params.estimated.protein,
      finalCalories: Math.round(finalCalories),
      finalCarbs: Math.round(finalCarbs),
      finalProtein: Math.round(finalProtein),
      confidence: params.estimated.confidence,
      editedByUser,
      entryType: params.entryType === 'snack' ? 'snack' : 'meal',
      isEstimate: true,
    };

    const store = this.readStore(now);
    store.meals.push(entry);
    this.writeStore(store, now);
    this.appendRecord(
      {
        id: crypto.randomUUID(),
        timestamp: now.toISOString(),
        date: todayDateString(now),
        action: 'log',
        status: 'DONE',
        photoRef: params.photoRef,
        estimated: params.estimated,
        approved: true,
        edited: editedByUser,
        finalValues: {
          itemName: entry.itemName,
          calories: entry.finalCalories,
          carbs: entry.finalCarbs,
          protein: entry.finalProtein,
          portionAssumed: entry.portionAssumed,
        },
        ignoredInjectionText: params.ignoredInjectionText,
      },
      now,
    );

    return { ok: true, entry };
  }

  deleteMealEntry(
    mealId: string,
    approvalText: unknown,
    now: Date = new Date(),
  ): { ok: boolean; error?: string } {
    const decision = parseApproval(approvalText);
    if (decision !== 'approved') {
      return {
        ok: false,
        error: 'Type "yes" to confirm removing this meal entry.',
      };
    }
    const store = this.readStore(now);
    const target = store.meals.find((m) => m.id === mealId);
    if (!target) {
      return { ok: false, error: 'Meal entry not found.' };
    }
    store.meals = store.meals.filter((m) => m.id !== mealId);
    this.writeStore(store, now);
    this.appendRecord(
      {
        id: crypto.randomUUID(),
        timestamp: now.toISOString(),
        date: todayDateString(now),
        action: 'delete',
        status: 'DONE',
        photoRef: target.photoRef,
        deletedMealId: mealId,
        note: `Deleted "${target.itemName}" (${target.finalCalories} kcal).`,
      },
      now,
    );
    return { ok: true };
  }

  getDailySummary(now: Date = new Date()): DailySummary {
    const store = this.readStore(now);
    const today = todayDateString(now);
    const todaysMeals = store.meals.filter((m) => m.date === today);
    const todaysBurns = store.burns.filter((b) => b.date === today);

    const caloriesLogged = todaysMeals.reduce((sum, m) => sum + m.finalCalories, 0);
    const carbsLogged = todaysMeals.reduce((sum, m) => sum + m.finalCarbs, 0);
    const proteinLogged = todaysMeals.reduce((sum, m) => sum + m.finalProtein, 0);
    const caloriesBurned = todaysBurns.reduce((sum, b) => sum + b.calories, 0);
    const netCalories = caloriesLogged - caloriesBurned;
    const remainingCalories = store.dailyCalorieGoal - netCalories;
    const proteinRemaining = store.dailyProteinGoal - proteinLogged;

    return {
      date: today,
      dailyCalorieGoal: store.dailyCalorieGoal,
      dailyProteinGoal: store.dailyProteinGoal,
      caloriesLogged,
      carbsLogged,
      proteinLogged,
      proteinRemaining,
      proteinTargetMet: proteinLogged >= store.dailyProteinGoal,
      caloriesBurned,
      netCalories,
      remainingCalories,
      inDeficitRange: netCalories <= store.dailyCalorieGoal,
      scansUsedToday: this.countScansToday(now),
      dailyScanCap: CONFIG.dailyScanCap,
      meals: todaysMeals,
      burns: todaysBurns,
    };
  }
}

export async function runApprovedScan(params: {
  staged: StagedPhoto;
  approvalText: unknown;
  store: LocalStore;
  scanProvider: ScanProvider;
  now?: Date;
}): Promise<ScanResult> {
  const now = params.now ?? new Date();
  const scansUsedToday = params.store.countScansToday(now);
  const decision = parseApproval(params.approvalText);

  if (decision === 'invalid') {
    return {
      status: 'NEEDS_HUMAN',
      attempts: 0,
      retriesUsed: 0,
      failedChecks: ['Scan approval not confirmed.'],
      message: 'Approval required: type "yes" to scan this photo, or "no" to discard.',
      ignoredInjectionText: params.staged.ignoredInjectionText,
      scansUsedToday,
      dailyScanCap: CONFIG.dailyScanCap,
    };
  }

  if (decision === 'rejected') {
    params.store.appendRecord(
      {
        id: crypto.randomUUID(),
        timestamp: now.toISOString(),
        date: todayDateString(now),
        action: 'scan',
        status: 'DONE',
        photoRef: params.staged.photoRef,
        approved: false,
        ignoredInjectionText: params.staged.ignoredInjectionText,
        note: 'User cancelled before scanning.',
      },
      now,
    );
    return {
      status: 'NEEDS_HUMAN',
      attempts: 0,
      retriesUsed: 0,
      failedChecks: [],
      message: 'Photo discarded. Nothing was scanned or logged.',
      ignoredInjectionText: params.staged.ignoredInjectionText,
      scansUsedToday,
      dailyScanCap: CONFIG.dailyScanCap,
    };
  }

  if (scansUsedToday >= CONFIG.dailyScanCap) {
    params.store.appendRecord(
      {
        id: crypto.randomUUID(),
        timestamp: now.toISOString(),
        date: todayDateString(now),
        action: 'scan',
        status: 'NEEDS_HUMAN',
        photoRef: params.staged.photoRef,
        approved: true,
        failedChecks: [`Daily scan limit (${CONFIG.dailyScanCap}) reached.`],
        ignoredInjectionText: params.staged.ignoredInjectionText,
        note: 'blocked_at_cap',
      },
      now,
    );
    return {
      status: 'NEEDS_HUMAN',
      attempts: 0,
      retriesUsed: 0,
      failedChecks: [`Daily scan cap of ${CONFIG.dailyScanCap} reached.`],
      message: `Daily scan limit of ${CONFIG.dailyScanCap} scans reached. You can still enter meal values manually.`,
      ignoredInjectionText: params.staged.ignoredInjectionText,
      scansUsedToday,
      dailyScanCap: CONFIG.dailyScanCap,
    };
  }

  let attempts = 0;
  let lastFailedChecks: string[] = [];
  let lastDetectedInjection = params.staged.ignoredInjectionText;
  const maxAttempts = 1 + CONFIG.maxRetries;

  while (attempts < maxAttempts) {
    attempts += 1;
    const retryReason =
      attempts > 1 ? `Previous attempt failed checks: ${lastFailedChecks.join(' ')}` : undefined;

    let rawReply: unknown;
    try {
      rawReply = await params.scanProvider({
        base64Data: params.staged.base64Data,
        mimeType: params.staged.mimeType,
        caption: params.staged.caption,
        retryReason,
      });
    } catch (err) {
      const plainError = sanitizeToolErrorMessage(err);
      params.store.appendRecord(
        {
          id: crypto.randomUUID(),
          timestamp: now.toISOString(),
          date: todayDateString(now),
          action: 'scan',
          status: 'NEEDS_HUMAN',
          photoRef: params.staged.photoRef,
          approved: true,
          failedChecks: [plainError],
          ignoredInjectionText: lastDetectedInjection,
          note: `Scan failed on attempt ${attempts}.`,
        },
        now,
      );
      return {
        status: 'NEEDS_HUMAN',
        attempts,
        retriesUsed: attempts - 1,
        failedChecks: [plainError],
        message: plainError,
        ignoredInjectionText: lastDetectedInjection,
        scansUsedToday: scansUsedToday + 1,
        dailyScanCap: CONFIG.dailyScanCap,
      };
    }

    const validation = validateNutritionEstimate(rawReply);
    if (validation.detectedPromptInjection && !lastDetectedInjection) {
      lastDetectedInjection = validation.detectedPromptInjection;
    }

    if (validation.valid && validation.estimate) {
      params.store.appendRecord(
        {
          id: crypto.randomUUID(),
          timestamp: now.toISOString(),
          date: todayDateString(now),
          action: 'scan',
          status: 'DONE',
          photoRef: params.staged.photoRef,
          approved: true,
          estimated: {
            itemName: validation.estimate.itemName,
            calories: validation.estimate.calories,
            carbs: validation.estimate.carbs,
            protein: validation.estimate.protein,
            confidence: validation.estimate.confidence,
            portionAssumed: validation.estimate.portionAssumed,
          },
          ignoredInjectionText: lastDetectedInjection,
          note:
            attempts > 1
              ? `Succeeded after ${attempts - 1} retry.`
              : 'Passed all deterministic checks.',
        },
        now,
      );
      return {
        status: 'DONE',
        attempts,
        retriesUsed: attempts - 1,
        estimate: validation.estimate,
        failedChecks: [],
        message: 'Estimate ready. Review or edit values, then type "yes" to add to today\'s log.',
        ignoredInjectionText: lastDetectedInjection,
        scansUsedToday: scansUsedToday + 1,
        dailyScanCap: CONFIG.dailyScanCap,
      };
    }

    lastFailedChecks = validation.failedChecks;
    if (validation.stopImmediately) {
      break;
    }
  }

  params.store.appendRecord(
    {
      id: crypto.randomUUID(),
      timestamp: now.toISOString(),
      date: todayDateString(now),
      action: 'scan',
      status: 'NEEDS_HUMAN',
      photoRef: params.staged.photoRef,
      approved: true,
      failedChecks: lastFailedChecks,
      ignoredInjectionText: lastDetectedInjection,
      note: `Stopped after ${attempts} attempt(s) (${attempts - 1} retries).`,
    },
    now,
  );

  return {
    status: 'NEEDS_HUMAN',
    attempts,
    retriesUsed: Math.max(0, attempts - 1),
    failedChecks: lastFailedChecks,
    message: `${lastFailedChecks[0] ?? 'Scan did not pass validation checks.'} Upload a clearer photo or enter the meal manually.`,
    ignoredInjectionText: lastDetectedInjection,
    scansUsedToday: scansUsedToday + 1,
    dailyScanCap: CONFIG.dailyScanCap,
  };
}

export async function runApprovedTextEstimate(params: {
  staged: StagedTextMeal;
  approvalText: unknown;
  store: LocalStore;
  textProvider: TextEstimateProvider;
  now?: Date;
}): Promise<ScanResult> {
  const now = params.now ?? new Date();
  const scansUsedToday = params.store.countScansToday(now);
  const decision = parseApproval(params.approvalText);

  if (decision === 'invalid') {
    return {
      status: 'NEEDS_HUMAN',
      attempts: 0,
      retriesUsed: 0,
      failedChecks: ['Estimate approval not confirmed.'],
      message: 'Approval required: type "yes" to estimate nutrition, or "no" to discard.',
      ignoredInjectionText: params.staged.ignoredInjectionText,
      scansUsedToday,
      dailyScanCap: CONFIG.dailyScanCap,
    };
  }

  if (decision === 'rejected') {
    params.store.appendRecord(
      {
        id: crypto.randomUUID(),
        timestamp: now.toISOString(),
        date: todayDateString(now),
        action: 'scan',
        status: 'DONE',
        photoRef: params.staged.photoRef,
        approved: false,
        ignoredInjectionText: params.staged.ignoredInjectionText,
        note: `User cancelled ${params.staged.entryType} lookup before calling model.`,
      },
      now,
    );
    return {
      status: 'NEEDS_HUMAN',
      attempts: 0,
      retriesUsed: 0,
      failedChecks: [],
      message: 'Entry discarded. Nothing was estimated or logged.',
      ignoredInjectionText: params.staged.ignoredInjectionText,
      scansUsedToday,
      dailyScanCap: CONFIG.dailyScanCap,
    };
  }

  if (scansUsedToday >= CONFIG.dailyScanCap) {
    params.store.appendRecord(
      {
        id: crypto.randomUUID(),
        timestamp: now.toISOString(),
        date: todayDateString(now),
        action: 'scan',
        status: 'NEEDS_HUMAN',
        photoRef: params.staged.photoRef,
        approved: true,
        failedChecks: [`Daily scan limit (${CONFIG.dailyScanCap}) reached.`],
        ignoredInjectionText: params.staged.ignoredInjectionText,
        note: 'blocked_at_cap',
      },
      now,
    );
    return {
      status: 'NEEDS_HUMAN',
      attempts: 0,
      retriesUsed: 0,
      failedChecks: [`Daily scan cap of ${CONFIG.dailyScanCap} reached.`],
      message: `Daily scan limit of ${CONFIG.dailyScanCap} reached.`,
      ignoredInjectionText: params.staged.ignoredInjectionText,
      scansUsedToday,
      dailyScanCap: CONFIG.dailyScanCap,
    };
  }

  let attempts = 0;
  let lastFailedChecks: string[] = [];
  let lastDetectedInjection = params.staged.ignoredInjectionText;
  const maxAttempts = 1 + CONFIG.maxRetries;

  while (attempts < maxAttempts) {
    attempts += 1;
    const retryReason =
      attempts > 1 ? `Previous attempt failed checks: ${lastFailedChecks.join(' ')}` : undefined;

    let rawReply: unknown;
    try {
      rawReply = await params.textProvider({
        entryType: params.staged.entryType,
        mealDescription: params.staged.mealDescription,
        gramsOrAmount: params.staged.gramsOrAmount,
        retryReason,
      });
    } catch (err) {
      const plainError = sanitizeToolErrorMessage(err);
      params.store.appendRecord(
        {
          id: crypto.randomUUID(),
          timestamp: now.toISOString(),
          date: todayDateString(now),
          action: 'scan',
          status: 'NEEDS_HUMAN',
          photoRef: params.staged.photoRef,
          approved: true,
          failedChecks: [plainError],
          ignoredInjectionText: lastDetectedInjection,
          note: `Text estimate failed on attempt ${attempts}.`,
        },
        now,
      );
      return {
        status: 'NEEDS_HUMAN',
        attempts,
        retriesUsed: attempts - 1,
        failedChecks: [plainError],
        message: plainError,
        ignoredInjectionText: lastDetectedInjection,
        scansUsedToday: scansUsedToday + 1,
        dailyScanCap: CONFIG.dailyScanCap,
      };
    }

    const validation = validateNutritionEstimate(rawReply);
    if (validation.detectedPromptInjection && !lastDetectedInjection) {
      lastDetectedInjection = validation.detectedPromptInjection;
    }

    if (validation.valid && validation.estimate) {
      params.store.appendRecord(
        {
          id: crypto.randomUUID(),
          timestamp: now.toISOString(),
          date: todayDateString(now),
          action: 'scan',
          status: 'DONE',
          photoRef: params.staged.photoRef,
          approved: true,
          estimated: {
            itemName: validation.estimate.itemName,
            calories: validation.estimate.calories,
            carbs: validation.estimate.carbs,
            protein: validation.estimate.protein,
            confidence: validation.estimate.confidence,
            portionAssumed: validation.estimate.portionAssumed,
          },
          ignoredInjectionText: lastDetectedInjection,
          note: `${params.staged.entryType} gram estimate passed checks.`,
        },
        now,
      );
      return {
        status: 'DONE',
        attempts,
        retriesUsed: attempts - 1,
        estimate: validation.estimate,
        failedChecks: [],
        message: 'Estimate ready. Review or edit values, then type "yes" to add to today\'s log.',
        ignoredInjectionText: lastDetectedInjection,
        scansUsedToday: scansUsedToday + 1,
        dailyScanCap: CONFIG.dailyScanCap,
      };
    }

    lastFailedChecks = validation.failedChecks;
    if (validation.stopImmediately) {
      break;
    }
  }

  params.store.appendRecord(
    {
      id: crypto.randomUUID(),
      timestamp: now.toISOString(),
      date: todayDateString(now),
      action: 'scan',
      status: 'NEEDS_HUMAN',
      photoRef: params.staged.photoRef,
      approved: true,
      failedChecks: lastFailedChecks,
      ignoredInjectionText: lastDetectedInjection,
      note: `Text estimate stopped after ${attempts} attempt(s).`,
    },
    now,
  );

  return {
    status: 'NEEDS_HUMAN',
    attempts,
    retriesUsed: Math.max(0, attempts - 1),
    failedChecks: lastFailedChecks,
    message: `${lastFailedChecks[0] ?? 'Estimate did not pass checks.'} Try clarifying the meal and grams.`,
    ignoredInjectionText: lastDetectedInjection,
    scansUsedToday: scansUsedToday + 1,
    dailyScanCap: CONFIG.dailyScanCap,
  };
}
