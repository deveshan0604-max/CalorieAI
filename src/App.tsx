import React, { useEffect, useRef, useState } from 'react';
import { Camera, Eye, Flame, Info, Trash2, Upload, Utensils } from 'lucide-react';

interface MealLogEntry {
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
  confidence: 'high' | 'medium' | 'low';
  editedByUser: boolean;
  entryType?: 'meal' | 'snack';
  isEstimate: true;
}

interface BurnLogEntry {
  id: string;
  date: string;
  timestamp: string;
  source: string;
  calories: number;
}

interface DailySummary {
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

interface Limits {
  freeTierWarning: string;
  maxImageBytes: number;
  maxImageDimension: number;
  imageQuality: number;
  minCalorieGoal: number;
  maxCalorieGoal: number;
  minProteinGoal: number;
  maxProteinGoal: number;
  dailyScanCap: number;
}

interface NutritionEstimate {
  itemName: string;
  calories: number;
  carbs: number;
  protein: number;
  confidence: 'high' | 'medium' | 'low';
  portionAssumed: string;
}

type LogTab = 'photo' | 'manual' | 'snack';
type GoalTab = 'calories' | 'protein';

type WorkflowStage =
  | { kind: 'idle' }
  | {
      kind: 'awaiting_scan_approval';
      token: string;
      photoRef: string;
      previewUrl: string;
      ignoredInjectionText?: string;
    }
  | {
      kind: 'awaiting_text_approval';
      token: string;
      photoRef: string;
      entryType: 'meal' | 'snack';
      mealDescription: string;
      gramsOrAmount: string;
      ignoredInjectionText?: string;
    }
  | {
      kind: 'awaiting_log_approval';
      photoRef: string;
      entryType: 'meal' | 'snack';
      previewUrl?: string;
      estimate: NutritionEstimate;
      ignoredInjectionText?: string;
    }
  | {
      kind: 'needs_human';
      message: string;
      failedChecks: string[];
    };

const BURN_SOURCES = [
  'Gym / Apple Watch',
  'Gym Session',
  'Apple Watch',
  'Running / Cardio',
  'Other Workout',
] as const;

function estimateFatGrams(calories: number, carbs: number, protein: number): number {
  return Math.max(0, Math.round((calories - 4 * carbs - 4 * protein) / 9));
}

async function prepareUploadPayload(
  file: File,
  maxDimension: number,
  imageQuality: number,
): Promise<{ filename: string; mimeType: string; base64Data: string; previewUrl: string }> {
  const isAllowedImage =
    file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp';

  if (!isAllowedImage || file.size === 0) {
    const rawBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(rawBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return {
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      base64Data: btoa(binary),
      previewUrl: '',
    };
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
        const targetW = Math.max(1, Math.round(img.width * scale));
        const targetH = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          const base64Only = dataUrl.split(',')[1] ?? '';
          resolve({
            filename: file.name,
            mimeType: file.type,
            base64Data: base64Only,
            previewUrl: dataUrl,
          });
          return;
        }
        // Drawing to canvas resizes the image and strips EXIF/location metadata.
        ctx.drawImage(img, 0, 0, targetW, targetH);
        const outMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const resizedDataUrl = canvas.toDataURL(outMime, imageQuality);
        resolve({
          filename: file.name,
          mimeType: outMime,
          base64Data: resizedDataUrl.split(',')[1] ?? '',
          previewUrl: resizedDataUrl,
        });
      };
      img.onerror = () => {
        resolve({
          filename: file.name,
          mimeType: file.type,
          base64Data: dataUrl.split(',')[1] ?? '',
          previewUrl: '',
        });
      };
      img.src = dataUrl;
    };
    reader.onerror = () => {
      resolve({
        filename: file.name,
        mimeType: file.type,
        base64Data: '',
        previewUrl: '',
      });
    };
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [showTodayView, setShowTodayView] = useState<boolean>(true);
  const [sessionThumbnails, setSessionThumbnails] = useState<Record<string, string>>({});

  const [activeTab, setActiveTab] = useState<LogTab>('photo');
  const [summaryGoalTab, setSummaryGoalTab] = useState<GoalTab>('calories');
  const [goalCardTab, setGoalCardTab] = useState<GoalTab>('calories');

  const [goalInput, setGoalInput] = useState<string>('');
  const [proteinGoalInput, setProteinGoalInput] = useState<string>('');
  const [burnCaloriesInput, setBurnCaloriesInput] = useState<string>('');
  const [burnSourceInput, setBurnSourceInput] = useState<string>('Gym / Apple Watch');

  const [captionInput, setCaptionInput] = useState<string>('');
  const [manualMealInput, setManualMealInput] = useState<string>('');
  const [manualGramsInput, setManualGramsInput] = useState<string>('');
  const [snackNameInput, setSnackNameInput] = useState<string>('');
  const [snackGramsInput, setSnackGramsInput] = useState<string>('');

  const [stage, setStage] = useState<WorkflowStage>({ kind: 'idle' });
  const [scanApprovalInput, setScanApprovalInput] = useState<string>('');
  const [textApprovalInput, setTextApprovalInput] = useState<string>('');
  const [logApprovalInput, setLogApprovalInput] = useState<string>('');

  const [editItemName, setEditItemName] = useState<string>('');
  const [editPortion, setEditPortion] = useState<string>('');
  const [editCalories, setEditCalories] = useState<string>('');
  const [editCarbs, setEditCarbs] = useState<string>('');
  const [editProtein, setEditProtein] = useState<string>('');

  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteApprovalInput, setDeleteApprovalInput] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const todaySectionRef = useRef<HTMLElement | null>(null);

  async function loadState() {
    try {
      const res = await fetch('/api/state');
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Could not load daily calorie log.');
        return;
      }
      setSummary(data.summary);
      setLimits(data.limits);
      setGoalInput(String(data.summary.dailyCalorieGoal));
      setProteinGoalInput(String(data.summary.dailyProteinGoal));
    } catch {
      setErrorMessage('Could not connect to the local CalorieAI server.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadState();
  }, []);

  function switchTab(nextTab: LogTab) {
    setActiveTab(nextTab);
    setErrorMessage('');
    setStatusMessage('');
    setStage({ kind: 'idle' });
  }

  async function handleGoalSave(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    setBusy(true);
    try {
      const res = await fetch('/api/goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: goalInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Invalid daily calorie goal.');
        return;
      }
      setSummary(data.summary);
      setGoalInput(String(data.goal));
      setStatusMessage(`Daily calorie goal updated to ${data.goal} kcal.`);
    } catch {
      setErrorMessage('Could not update daily calorie goal.');
    } finally {
      setBusy(false);
    }
  }

  async function handleProteinGoalSave(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    setBusy(true);
    try {
      const res = await fetch('/api/protein-goal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: proteinGoalInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Invalid daily protein goal.');
        return;
      }
      setSummary(data.summary);
      setProteinGoalInput(String(data.goal));
      setStatusMessage(`Daily protein goal updated to ${data.goal} g.`);
    } catch {
      setErrorMessage('Could not update daily protein goal.');
    } finally {
      setBusy(false);
    }
  }

  async function handleBurnSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    setBusy(true);
    try {
      const res = await fetch('/api/burn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calories: burnCaloriesInput, source: burnSourceInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Invalid calories burned value.');
        return;
      }
      setSummary(data.summary);
      setBurnCaloriesInput('');
      setStatusMessage(`Logged ${data.entry.calories} kcal burned (${data.entry.source}).`);
    } catch {
      setErrorMessage('Could not log calories burned.');
    } finally {
      setBusy(false);
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setErrorMessage('');
    setStatusMessage('');
    setBusy(true);
    try {
      const maxDim = limits?.maxImageDimension ?? 768;
      const quality = limits?.imageQuality ?? 0.8;
      const payload = await prepareUploadPayload(file, maxDim, quality);
      const res = await fetch('/api/scan/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: payload.filename,
          mimeType: payload.mimeType,
          base64Data: payload.base64Data,
          caption: captionInput,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Upload rejected.');
        return;
      }
      setScanApprovalInput('');
      setStage({
        kind: 'awaiting_scan_approval',
        token: data.token,
        photoRef: data.photoRef,
        previewUrl: payload.previewUrl,
        ignoredInjectionText: data.ignoredInjectionText,
      });
    } catch {
      setErrorMessage('Could not stage photo for scanning.');
    } finally {
      setBusy(false);
    }
  }

  async function handleScanApproval(e: React.FormEvent) {
    e.preventDefault();
    if (stage.kind !== 'awaiting_scan_approval') return;
    setErrorMessage('');
    setStatusMessage('');
    setBusy(true);
    try {
      const res = await fetch('/api/scan/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: stage.token,
          approvalText: scanApprovalInput,
        }),
      });
      const data = await res.json();
      if (data.summary) {
        setSummary(data.summary);
      }

      if (!res.ok) {
        setErrorMessage(data.error || 'Scan failed.');
        return;
      }

      if (scanApprovalInput.trim().toLowerCase() === 'no') {
        setStage({ kind: 'idle' });
        setScanApprovalInput('');
        setStatusMessage(data.message || 'Photo discarded.');
        return;
      }

      if (data.status !== 'DONE' || !data.estimate) {
        if (data.failedChecks?.includes('Scan approval not confirmed.')) {
          setErrorMessage(data.message);
          return;
        }
        setStage({
          kind: 'needs_human',
          message: data.message || 'Could not complete scan. Upload a clearer photo or enter manually.',
          failedChecks: Array.isArray(data.failedChecks) ? data.failedChecks : [],
        });
        return;
      }

      const est = data.estimate as NutritionEstimate;
      setEditItemName(est.itemName);
      setEditPortion(est.portionAssumed);
      setEditCalories(String(est.calories));
      setEditCarbs(String(est.carbs));
      setEditProtein(String(est.protein));
      setLogApprovalInput('');
      setStage({
        kind: 'awaiting_log_approval',
        photoRef: data.photoRef || stage.photoRef,
        entryType: 'meal',
        previewUrl: stage.previewUrl,
        estimate: est,
        ignoredInjectionText: data.ignoredInjectionText,
      });
    } catch {
      setErrorMessage('Network or server error while scanning photo.');
    } finally {
      setBusy(false);
    }
  }

  async function handleStageTextMeal(e: React.FormEvent, entryType: 'meal' | 'snack') {
    e.preventDefault();
    setErrorMessage('');
    setStatusMessage('');
    setBusy(true);
    try {
      const mealDescription = entryType === 'snack' ? snackNameInput : manualMealInput;
      const gramsOrAmount = entryType === 'snack' ? snackGramsInput : manualGramsInput;

      const res = await fetch('/api/text/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryType,
          mealDescription,
          gramsOrAmount,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Could not stage entry.');
        return;
      }

      setTextApprovalInput('');
      setStage({
        kind: 'awaiting_text_approval',
        token: data.token,
        photoRef: data.photoRef,
        entryType: data.entryType,
        mealDescription: data.mealDescription,
        gramsOrAmount: data.gramsOrAmount,
        ignoredInjectionText: data.ignoredInjectionText,
      });
    } catch {
      setErrorMessage('Could not connect to CalorieAI server.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTextApproval(e: React.FormEvent) {
    e.preventDefault();
    if (stage.kind !== 'awaiting_text_approval') return;
    setErrorMessage('');
    setStatusMessage('');
    setBusy(true);
    try {
      const res = await fetch('/api/text/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: stage.token,
          approvalText: textApprovalInput,
        }),
      });
      const data = await res.json();
      if (data.summary) {
        setSummary(data.summary);
      }

      if (!res.ok) {
        setErrorMessage(data.error || 'Estimation failed.');
        return;
      }

      if (textApprovalInput.trim().toLowerCase() === 'no') {
        setStage({ kind: 'idle' });
        setTextApprovalInput('');
        setStatusMessage(data.message || 'Entry discarded.');
        return;
      }

      if (data.status !== 'DONE' || !data.estimate) {
        if (data.failedChecks?.includes('Estimate approval not confirmed.')) {
          setErrorMessage(data.message);
          return;
        }
        setStage({
          kind: 'needs_human',
          message: data.message || 'Could not estimate nutrition. Clarify the item and grams.',
          failedChecks: Array.isArray(data.failedChecks) ? data.failedChecks : [],
        });
        return;
      }

      const est = data.estimate as NutritionEstimate;
      setEditItemName(est.itemName);
      setEditPortion(est.portionAssumed);
      setEditCalories(String(est.calories));
      setEditCarbs(String(est.carbs));
      setEditProtein(String(est.protein));
      setLogApprovalInput('');
      setStage({
        kind: 'awaiting_log_approval',
        photoRef: data.photoRef || stage.photoRef,
        entryType: stage.entryType,
        estimate: est,
        ignoredInjectionText: data.ignoredInjectionText,
      });
    } catch {
      setErrorMessage('Network or server error while estimating nutrition.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogApproval(e: React.FormEvent) {
    e.preventDefault();
    if (stage.kind !== 'awaiting_log_approval') return;
    setErrorMessage('');
    setStatusMessage('');
    setBusy(true);
    const savedPreviewUrl = stage.previewUrl;
    const savedEntryType = stage.entryType;
    try {
      const res = await fetch('/api/log/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approvalText: logApprovalInput,
          photoRef: stage.photoRef,
          entryType: savedEntryType,
          estimated: stage.estimate,
          editedValues: {
            itemName: editItemName,
            portionAssumed: editPortion,
            calories: Number(editCalories),
            carbs: Number(editCarbs),
            protein: Number(editProtein),
          },
          ignoredInjectionText: stage.ignoredInjectionText,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Could not save meal entry.');
        return;
      }
      if (data.entry?.id && savedPreviewUrl) {
        setSessionThumbnails((prev) => ({ ...prev, [data.entry.id]: savedPreviewUrl }));
      }
      if (data.summary) {
        setSummary(data.summary);
      }
      setStage({ kind: 'idle' });
      setLogApprovalInput('');
      setCaptionInput('');
      if (!data.discarded) {
        if (savedEntryType === 'snack') {
          setSnackNameInput('');
          setSnackGramsInput('');
        } else if (stage.photoRef === 'manual-entry') {
          setManualMealInput('');
          setManualGramsInput('');
        }
      }
      setStatusMessage(
        data.discarded
          ? 'Estimate discarded without saving to today\'s log.'
          : `Saved "${data.entry.itemName}" (${data.entry.finalCalories} kcal estimate) to today's log.`,
      );
    } catch {
      setErrorMessage('Could not save meal entry.');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmDelete(mealId: string) {
    setErrorMessage('');
    setStatusMessage('');
    setBusy(true);
    try {
      const res = await fetch(`/api/meals/${encodeURIComponent(mealId)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalText: deleteApprovalInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Could not delete meal entry.');
        return;
      }
      setSummary(data.summary);
      setDeleteTargetId(null);
      setDeleteApprovalInput('');
      setStatusMessage('Entry removed from today\'s log.');
    } catch {
      setErrorMessage('Could not delete entry.');
    } finally {
      setBusy(false);
    }
  }

  function handleViewTodayClick() {
    setShowTodayView(true);
    requestAnimationFrame(() => {
      todaySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  const cardClass =
    'rounded-[12px] border border-[#334155] bg-[#1E293B] shadow-[0_4px_16px_0_rgba(2,6,23,0.35)]';

  const primaryBtnClass =
    'inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg bg-[#0F766E] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#115E59] disabled:opacity-50 whitespace-nowrap shrink-0';

  const secondaryBtnClass =
    'inline-flex min-h-[42px] items-center justify-center gap-2 rounded-lg border border-[#475569] bg-[#334155] px-4 py-2 text-sm font-medium text-[#F8FAFC] transition-colors hover:bg-[#3E4C63] disabled:opacity-50 whitespace-nowrap shrink-0';

  const inputClass =
    'rounded-lg border border-[#475569] bg-[#334155] px-3 py-2 text-sm text-[#F8FAFC] placeholder:text-[#94A3B8] focus:border-[#14B8A6] focus:outline-none';

  const goalStatus = (() => {
    if (!summary) {
      return {
        color: '#22C55E',
        label: 'In range',
        pct: 0,
        fatLogged: 0,
      };
    }
    const goal = Math.max(1, summary.dailyCalorieGoal);
    const pct = Math.max(0, Math.min(100, Math.round((summary.netCalories / goal) * 100)));
    const fatLogged = estimateFatGrams(
      summary.caloriesLogged,
      summary.carbsLogged,
      summary.proteinLogged,
    );

    if (!summary.inDeficitRange) {
      return {
        color: '#F87171',
        label: `Over goal by ${Math.abs(summary.remainingCalories)} kcal`,
        pct: 100,
        fatLogged,
      };
    }
    if (summary.netCalories >= goal * 0.85) {
      return {
        color: '#FBBF24',
        label: `Near limit · ${summary.remainingCalories} kcal left`,
        pct,
        fatLogged,
      };
    }
    return {
      color: '#4ADE80',
      label: `In deficit range · ${summary.remainingCalories} kcal left`,
      pct,
      fatLogged,
    };
  })();

  const proteinStatus = (() => {
    if (!summary) {
      return {
        color: '#2DD4BF',
        label: 'In progress',
        pct: 0,
        remaining: 0,
      };
    }
    const target = Math.max(1, summary.dailyProteinGoal);
    const pct = Math.max(0, Math.min(100, Math.round((summary.proteinLogged / target) * 100)));
    const remaining = Math.max(0, summary.proteinRemaining);

    if (summary.proteinTargetMet) {
      return {
        color: '#4ADE80',
        label: `Target reached (${summary.proteinLogged}g / ${target}g)`,
        pct: 100,
        remaining: 0,
      };
    }
    if (pct >= 75) {
      return {
        color: '#2DD4BF',
        label: `Almost there · ${remaining}g to go`,
        pct,
        remaining,
      };
    }
    return {
      color: '#FBBF24',
      label: `${remaining}g remaining to reach target`,
      pct,
      remaining,
    };
  })();

  return (
    <div className="min-h-screen bg-[#1E3A5F] text-[#F8FAFC] tracking-[0.01em]">
      <header className="border-b border-[#334155] bg-[#1E293B]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-8 px-6 py-4">
          <h1 className="text-xl font-bold tracking-tight text-[#F8FAFC] whitespace-nowrap shrink-0">
            CalorieAI
          </h1>
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleViewTodayClick}
              className={secondaryBtnClass}
            >
              <Eye className="h-4 w-4 text-[#CBD5E1]" />
              View Today&apos;s Calories
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-6 py-6">
        {showTodayView && (
          <section ref={todaySectionRef} className={`${cardClass} p-6 space-y-5`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-semibold text-[#F8FAFC]">
                    {summaryGoalTab === 'calories'
                      ? "Today's Calories vs Goal"
                      : "Today's Protein vs Goal"}
                  </h2>
                  <div className="inline-flex items-center gap-1 rounded-lg bg-[#0F172A]/60 p-0.5 border border-[#334155]">
                    <button
                      type="button"
                      onClick={() => setSummaryGoalTab('calories')}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        summaryGoalTab === 'calories'
                          ? 'bg-[#334155] text-[#F8FAFC] shadow-sm'
                          : 'text-[#CBD5E1] hover:text-[#F8FAFC]'
                      }`}
                    >
                      Calories
                    </button>
                    <button
                      type="button"
                      onClick={() => setSummaryGoalTab('protein')}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        summaryGoalTab === 'protein'
                          ? 'bg-[#334155] text-[#F8FAFC] shadow-sm'
                          : 'text-[#CBD5E1] hover:text-[#F8FAFC]'
                      }`}
                    >
                      Protein Goal
                    </button>
                  </div>
                </div>
                {summary && (
                  <p className="text-xs text-[#CBD5E1] font-mono tabular-nums">
                    {summary.date} ·{' '}
                    {summaryGoalTab === 'calories'
                      ? `Goal ${summary.dailyCalorieGoal} kcal`
                      : `Goal ${summary.dailyProteinGoal} g`}{' '}
                    · Scans {summary.scansUsedToday}/{summary.dailyScanCap}
                  </p>
                )}
              </div>
              {summary && (
                <p
                  className="text-sm font-semibold tabular-nums"
                  style={{
                    color:
                      summaryGoalTab === 'calories' ? goalStatus.color : proteinStatus.color,
                  }}
                >
                  {summaryGoalTab === 'calories' ? goalStatus.label : proteinStatus.label}
                </p>
              )}
            </div>

            {loading || !summary ? (
              <p className="text-sm text-[#CBD5E1]">Loading today&apos;s summary...</p>
            ) : summaryGoalTab === 'calories' ? (
              <>
                <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <div className="text-xs font-medium text-[#CBD5E1]">Remaining Today</div>
                    <div
                      className="mt-1 text-4xl font-bold tracking-tight font-mono tabular-nums"
                      style={{ color: goalStatus.color }}
                    >
                      {summary.remainingCalories} <span className="text-lg font-medium">kcal</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-6 sm:gap-8">
                    <div>
                      <div className="text-xs text-[#CBD5E1]">Eaten (est.)</div>
                      <div className="mt-0.5 text-lg font-semibold font-mono tabular-nums text-[#F8FAFC]">
                        {summary.caloriesLogged} kcal
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-[#CBD5E1]">Burned</div>
                      <div className="mt-0.5 text-lg font-semibold font-mono tabular-nums text-[#F8FAFC]">
                        {summary.caloriesBurned} kcal
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-[#CBD5E1]">Net / Remaining</div>
                      <div className="mt-0.5 text-lg font-semibold font-mono tabular-nums text-[#F8FAFC]">
                        {summary.netCalories} / {summary.remainingCalories}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#334155]">
                    <div
                      className="h-full rounded-full transition-all duration-200"
                      style={{
                        width: `${goalStatus.pct}%`,
                        backgroundColor: goalStatus.color,
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[#CBD5E1]">
                    <div className="flex items-center gap-4 font-mono tabular-nums">
                      <span>Protein: {summary.proteinLogged}g</span>
                      <span aria-hidden="true">·</span>
                      <span>Carbs: {summary.carbsLogged}g</span>
                      <span aria-hidden="true">·</span>
                      <span>Fat (est.): {goalStatus.fatLogged}g</span>
                    </div>
                    <span className="font-mono tabular-nums">
                      {goalStatus.pct}% of {summary.dailyCalorieGoal} kcal goal
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <div className="text-xs font-medium text-[#CBD5E1]">
                      {summary.proteinTargetMet ? 'Protein Target Met' : 'Protein Remaining'}
                    </div>
                    <div
                      className="mt-1 text-4xl font-bold tracking-tight font-mono tabular-nums"
                      style={{ color: proteinStatus.color }}
                    >
                      {proteinStatus.remaining} <span className="text-lg font-medium">g</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-6 sm:gap-8">
                    <div>
                      <div className="text-xs text-[#CBD5E1]">Protein Eaten</div>
                      <div className="mt-0.5 text-lg font-semibold font-mono tabular-nums text-[#F8FAFC]">
                        {summary.proteinLogged} g
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-[#CBD5E1]">Daily Target</div>
                      <div className="mt-0.5 text-lg font-semibold font-mono tabular-nums text-[#F8FAFC]">
                        {summary.dailyProteinGoal} g
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-[#CBD5E1]">Remaining</div>
                      <div className="mt-0.5 text-lg font-semibold font-mono tabular-nums text-[#F8FAFC]">
                        {proteinStatus.remaining} g
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-[#334155]">
                    <div
                      className="h-full rounded-full transition-all duration-200"
                      style={{
                        width: `${proteinStatus.pct}%`,
                        backgroundColor: proteinStatus.color,
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[#CBD5E1]">
                    <div className="flex items-center gap-4 font-mono tabular-nums">
                      <span>Calories: {summary.caloriesLogged} kcal</span>
                      <span aria-hidden="true">·</span>
                      <span>Carbs: {summary.carbsLogged}g</span>
                      <span aria-hidden="true">·</span>
                      <span>Fat (est.): {goalStatus.fatLogged}g</span>
                    </div>
                    <span className="font-mono tabular-nums">
                      {proteinStatus.pct}% of {summary.dailyProteinGoal} g goal
                    </span>
                  </div>
                </div>
              </>
            )}
          </section>
        )}

        <section className={`${cardClass} p-6 space-y-4`}>
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-[#F8FAFC]">Today&apos;s Meals</h2>
            <span className="text-xs text-[#CBD5E1] font-mono tabular-nums">
              {summary ? `${summary.meals.length} logged` : '0 logged'}
            </span>
          </div>

          {loading || !summary ? (
            <p className="text-sm text-[#CBD5E1]">Loading meals...</p>
          ) : summary.meals.length === 0 ? (
            <p className="text-sm text-[#CBD5E1]">
              No meals logged yet today. Log a meal photo, manual gram entry, or snack below.
            </p>
          ) : (
            <div className="divide-y divide-[#334155] border-t border-[#334155]">
              {summary.meals.map((meal) => {
                const thumbUrl = sessionThumbnails[meal.id];
                const mealFat = estimateFatGrams(
                  meal.finalCalories,
                  meal.finalCarbs,
                  meal.finalProtein,
                );
                return (
                  <div
                    key={meal.id}
                    className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      {thumbUrl ? (
                        <img
                          src={thumbUrl}
                          alt={meal.itemName}
                          referrerPolicy="no-referrer"
                          className="h-11 w-11 rounded-lg border border-[#475569] object-cover shrink-0"
                        />
                      ) : (
                        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-[#475569] bg-[#334155] text-[#CBD5E1] shrink-0">
                          <Utensils className="h-4 w-4" />
                        </div>
                      )}

                      <div className="min-w-0 space-y-0.5">
                        <div className="text-sm font-semibold text-[#F8FAFC] truncate">
                          {meal.itemName}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-[#CBD5E1]">
                          {meal.entryType === 'snack' && (
                            <>
                              <span>Snack</span>
                              <span aria-hidden="true">·</span>
                            </>
                          )}
                          <span>{meal.portionAssumed}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono font-semibold tabular-nums text-[#F8FAFC]">
                            ~{meal.finalCalories} kcal
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            P {meal.finalProtein}g / C {meal.finalCarbs}g / F {mealFat}g
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {deleteTargetId === meal.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={deleteApprovalInput}
                            onChange={(e) => setDeleteApprovalInput(e.target.value)}
                            placeholder='Type "yes"'
                            aria-label={`Confirm delete ${meal.itemName}`}
                            className={`w-24 py-1.5 text-xs font-mono ${inputClass}`}
                          />
                          <button
                            type="button"
                            onClick={() => handleConfirmDelete(meal.id)}
                            disabled={busy}
                            className="min-h-[36px] rounded-lg px-2.5 py-1.5 text-xs font-semibold text-[#F87171] hover:bg-red-950/60 whitespace-nowrap"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteTargetId(null);
                              setDeleteApprovalInput('');
                            }}
                            className="min-h-[36px] rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] hover:bg-[#334155] whitespace-nowrap"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteTargetId(meal.id);
                            setDeleteApprovalInput('');
                          }}
                          aria-label={`Delete ${meal.itemName}`}
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#CBD5E1] transition-colors hover:bg-red-950/60 hover:text-[#F87171] whitespace-nowrap"
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className={`${cardClass} p-6 space-y-5`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-bold tracking-tight text-[#F8FAFC]">
                Log a New Meal
              </h2>
              <p className="text-sm text-[#CBD5E1]">
                Every scan, lookup, and log entry requires typing{' '}
                <span className="font-mono font-semibold text-[#F8FAFC]">yes</span> to confirm.
              </p>
            </div>

            <div className="inline-flex items-center gap-1 rounded-lg bg-[#0F172A]/60 p-1 border border-[#334155] self-start">
              <button
                type="button"
                onClick={() => switchTab('photo')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'photo'
                    ? 'bg-[#334155] text-[#F8FAFC] shadow-sm'
                    : 'text-[#CBD5E1] hover:text-[#F8FAFC]'
                }`}
              >
                Meal Photo
              </button>
              <button
                type="button"
                onClick={() => switchTab('manual')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'manual'
                    ? 'bg-[#334155] text-[#F8FAFC] shadow-sm'
                    : 'text-[#CBD5E1] hover:text-[#F8FAFC]'
                }`}
              >
                Manual Meal
              </button>
              <button
                type="button"
                onClick={() => switchTab('snack')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'snack'
                    ? 'bg-[#334155] text-[#F8FAFC] shadow-sm'
                    : 'text-[#CBD5E1] hover:text-[#F8FAFC]'
                }`}
              >
                Snacks
              </button>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileSelected}
            className="sr-only"
            aria-label="Upload meal photo"
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            onChange={handleFileSelected}
            className="sr-only"
            aria-label="Take meal photo"
          />

          {activeTab === 'photo' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                    className={`${primaryBtnClass} w-full`}
                  >
                    <Upload className="h-4 w-4" />
                    Upload Food Photo
                  </button>
                  <button
                    type="button"
                    onClick={() => cameraInputRef.current?.click()}
                    disabled={busy}
                    className={`${secondaryBtnClass} w-full`}
                  >
                    <Camera className="h-4 w-4 text-[#CBD5E1]" />
                    Take Photo
                  </button>
                </div>
                <p className="flex items-center gap-1.5 text-xs text-[#CBD5E1] truncate">
                  <Info className="h-3.5 w-3.5 shrink-0 text-[#2DD4BF]" />
                  <span className="truncate">
                    {limits?.freeTierWarning ??
                      'Free-tier scans may be processed by Google under standard terms. Keep faces, documents, and personal details out of frame.'}
                  </span>
                </p>
              </div>

              <div>
                <label htmlFor="meal-caption" className="block text-xs font-medium text-[#CBD5E1] mb-1">
                  Optional meal note (data only, never instructions)
                </label>
                <input
                  id="meal-caption"
                  type="text"
                  value={captionInput}
                  onChange={(e) => setCaptionInput(e.target.value)}
                  placeholder="e.g. Grilled chicken breast after gym"
                  maxLength={200}
                  className={`w-full ${inputClass}`}
                />
              </div>
            </div>
          )}

          {activeTab === 'manual' && (
            <form onSubmit={(e) => handleStageTextMeal(e, 'meal')} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="manual-meal-name" className="block text-xs font-medium text-[#CBD5E1] mb-1">
                    What is the meal?
                  </label>
                  <input
                    id="manual-meal-name"
                    type="text"
                    value={manualMealInput}
                    onChange={(e) => setManualMealInput(e.target.value)}
                    placeholder="e.g. Grilled chicken breast and white rice"
                    maxLength={180}
                    className={`w-full ${inputClass}`}
                  />
                </div>
                <div>
                  <label htmlFor="manual-meal-grams" className="block text-xs font-medium text-[#CBD5E1] mb-1">
                    How many grams?
                  </label>
                  <input
                    id="manual-meal-grams"
                    type="text"
                    value={manualGramsInput}
                    onChange={(e) => setManualGramsInput(e.target.value)}
                    placeholder="e.g. 200g chicken, 150g cooked rice"
                    maxLength={120}
                    className={`w-full ${inputClass}`}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-[#CBD5E1]">
                  CalorieAI calculates calories, carbs, and protein from your meal and gram weights.
                </p>
                <button type="submit" disabled={busy} className={primaryBtnClass}>
                  Estimate Meal Nutrition
                </button>
              </div>
            </form>
          )}

          {activeTab === 'snack' && (
            <form onSubmit={(e) => handleStageTextMeal(e, 'snack')} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="snack-name" className="block text-xs font-medium text-[#CBD5E1] mb-1">
                    What is the snack? (no photo required)
                  </label>
                  <input
                    id="snack-name"
                    type="text"
                    value={snackNameInput}
                    onChange={(e) => setSnackNameInput(e.target.value)}
                    placeholder="e.g. Roasted almonds or whey protein bar"
                    maxLength={180}
                    className={`w-full ${inputClass}`}
                  />
                </div>
                <div>
                  <label htmlFor="snack-grams" className="block text-xs font-medium text-[#CBD5E1] mb-1">
                    Grams or portion
                  </label>
                  <input
                    id="snack-grams"
                    type="text"
                    value={snackGramsInput}
                    onChange={(e) => setSnackGramsInput(e.target.value)}
                    placeholder="e.g. 30g or 1 bar (60g)"
                    maxLength={120}
                    className={`w-full ${inputClass}`}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-[#CBD5E1]">
                  Log snacks quickly by name and grams without uploading a photo.
                </p>
                <button type="submit" disabled={busy} className={primaryBtnClass}>
                  Estimate Snack Nutrition
                </button>
              </div>
            </form>
          )}

          {errorMessage && (
            <div
              role="alert"
              className="rounded-lg border border-red-700/60 bg-red-950/60 px-4 py-3 text-sm text-red-200"
            >
              {errorMessage}
            </div>
          )}

          {statusMessage && (
            <div
              role="status"
              className="rounded-lg border border-emerald-700/60 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200"
            >
              {statusMessage}
            </div>
          )}

          {stage.kind === 'awaiting_scan_approval' && (
            <form
              onSubmit={handleScanApproval}
              className="rounded-[12px] border border-[#0D9488]/60 bg-[#263548] p-5 space-y-4"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                {stage.previewUrl && (
                  <img
                    src={stage.previewUrl}
                    alt="Staged meal preview"
                    referrerPolicy="no-referrer"
                    className="h-24 w-24 rounded-lg border border-[#475569] object-cover shrink-0"
                  />
                )}
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-[#F8FAFC]">
                    Confirm Photo Scan (Step 1 of 2)
                  </p>
                  <p className="text-xs text-[#CBD5E1] font-mono">{stage.photoRef}</p>
                  <p className="text-sm text-[#CBD5E1]">
                    Type <span className="font-mono font-semibold text-[#F8FAFC]">yes</span> to
                    send this photo to Gemini for analysis, or{' '}
                    <span className="font-mono font-semibold text-[#F8FAFC]">no</span> to discard.
                  </p>
                  {stage.ignoredInjectionText && (
                    <p className="text-xs text-[#FBBF24]">
                      Note: Instruction-like text in filename/caption was recorded and ignored.
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={scanApprovalInput}
                  onChange={(e) => setScanApprovalInput(e.target.value)}
                  placeholder='Type "yes" or "no"'
                  aria-label="Scan approval confirmation"
                  className={`w-full sm:w-56 font-mono ${inputClass}`}
                />
                <button type="submit" disabled={busy} className={primaryBtnClass}>
                  {busy ? 'Scanning...' : 'Confirm Scan'}
                </button>
              </div>
            </form>
          )}

          {stage.kind === 'awaiting_text_approval' && (
            <form
              onSubmit={handleTextApproval}
              className="rounded-[12px] border border-[#0D9488]/60 bg-[#263548] p-5 space-y-4"
            >
              <div className="space-y-1">
                <p className="text-sm font-semibold text-[#F8FAFC]">
                  Confirm {stage.entryType === 'snack' ? 'Snack' : 'Meal'} Estimate (Step 1 of 2)
                </p>
                <p className="text-xs text-[#CBD5E1]">
                  {stage.mealDescription} · <span className="font-mono">{stage.gramsOrAmount}</span>
                </p>
                <p className="text-sm text-[#CBD5E1]">
                  Type <span className="font-mono font-semibold text-[#F8FAFC]">yes</span> to
                  calculate calories, carbs, and protein, or{' '}
                  <span className="font-mono font-semibold text-[#F8FAFC]">no</span> to discard.
                </p>
                {stage.ignoredInjectionText && (
                  <p className="text-xs text-[#FBBF24]">
                    Note: Instruction-like text in your entry was recorded and ignored.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={textApprovalInput}
                  onChange={(e) => setTextApprovalInput(e.target.value)}
                  placeholder='Type "yes" or "no"'
                  aria-label="Nutrition estimate approval confirmation"
                  className={`w-full sm:w-56 font-mono ${inputClass}`}
                />
                <button type="submit" disabled={busy} className={primaryBtnClass}>
                  {busy ? 'Calculating...' : 'Confirm Estimate'}
                </button>
              </div>
            </form>
          )}

          {stage.kind === 'needs_human' && (
            <div className="rounded-[12px] border border-amber-700/60 bg-amber-950/50 p-5 space-y-3">
              <p className="text-sm font-semibold text-[#F8FAFC]">Scan stopped (NEEDS HUMAN)</p>
              <p className="text-sm text-[#CBD5E1]">{stage.message}</p>
              {stage.failedChecks.length > 1 && (
                <ul className="list-disc pl-5 text-xs text-[#CBD5E1] space-y-1">
                  {stage.failedChecks.map((check, i) => (
                    <li key={i}>{check}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    switchTab('photo');
                    fileInputRef.current?.click();
                  }}
                  className={primaryBtnClass}
                >
                  Upload New Photo
                </button>
                <button
                  type="button"
                  onClick={() => switchTab('manual')}
                  className={secondaryBtnClass}
                >
                  Enter Meal Manually
                </button>
              </div>
            </div>
          )}

          {stage.kind === 'awaiting_log_approval' && (
            <form
              onSubmit={handleLogApproval}
              className="rounded-[12px] border border-[#0D9488]/60 bg-[#263548] p-5 space-y-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-[#F8FAFC]">
                  Confirm {stage.entryType === 'snack' ? 'Snack' : 'Meal'} Log (Step 2 of 2)
                </p>
                <p className="text-xs text-[#CBD5E1]">
                  Confidence:{' '}
                  <span className="font-mono font-semibold text-[#F8FAFC]">
                    {stage.estimate.confidence}
                  </span>{' '}
                  · Values are estimates (edit before typing yes)
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div className="lg:col-span-2">
                  <label className="block text-xs text-[#CBD5E1] mb-1">Item</label>
                  <input
                    type="text"
                    value={editItemName}
                    onChange={(e) => setEditItemName(e.target.value)}
                    className={`w-full ${inputClass}`}
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#CBD5E1] mb-1">Portion Assumed</label>
                  <input
                    type="text"
                    value={editPortion}
                    onChange={(e) => setEditPortion(e.target.value)}
                    className={`w-full ${inputClass}`}
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#CBD5E1] mb-1">Calories (kcal est.)</label>
                  <input
                    type="number"
                    min="0"
                    value={editCalories}
                    onChange={(e) => setEditCalories(e.target.value)}
                    className={`w-full font-mono tabular-nums ${inputClass}`}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-[#CBD5E1] mb-1">Carbs (g)</label>
                    <input
                      type="number"
                      min="0"
                      value={editCarbs}
                      onChange={(e) => setEditCarbs(e.target.value)}
                      className={`w-full font-mono tabular-nums ${inputClass}`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#CBD5E1] mb-1">Protein (g)</label>
                    <input
                      type="number"
                      min="0"
                      value={editProtein}
                      onChange={(e) => setEditProtein(e.target.value)}
                      className={`w-full font-mono tabular-nums ${inputClass}`}
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={logApprovalInput}
                  onChange={(e) => setLogApprovalInput(e.target.value)}
                  placeholder='Type "yes" to save or "no" to discard'
                  aria-label="Log approval confirmation"
                  className={`w-full sm:w-72 font-mono ${inputClass}`}
                />
                <button type="submit" disabled={busy} className={primaryBtnClass}>
                  Confirm &amp; Log {stage.entryType === 'snack' ? 'Snack' : 'Meal'}
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className={`${cardClass} p-5 space-y-3`}>
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1 rounded-lg bg-[#0F172A]/60 p-0.5 border border-[#334155]">
                <button
                  type="button"
                  onClick={() => setGoalCardTab('calories')}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    goalCardTab === 'calories'
                      ? 'bg-[#334155] text-[#F8FAFC] shadow-sm'
                      : 'text-[#CBD5E1] hover:text-[#F8FAFC]'
                  }`}
                >
                  Calorie Goal
                </button>
                <button
                  type="button"
                  onClick={() => setGoalCardTab('protein')}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    goalCardTab === 'protein'
                      ? 'bg-[#334155] text-[#F8FAFC] shadow-sm'
                      : 'text-[#CBD5E1] hover:text-[#F8FAFC]'
                  }`}
                >
                  Protein Goal
                </button>
              </div>
              <span className="text-xs text-[#CBD5E1]">Persists until changed</span>
            </div>

            {goalCardTab === 'calories' ? (
              <form onSubmit={handleGoalSave} className="flex items-center gap-2.5">
                <input
                  type="text"
                  inputMode="numeric"
                  value={goalInput}
                  onChange={(e) => setGoalInput(e.target.value)}
                  aria-label="Daily calorie goal"
                  className={`w-full max-w-[160px] font-mono tabular-nums ${inputClass}`}
                />
                <button type="submit" disabled={busy} className={secondaryBtnClass}>
                  Update Goal
                </button>
              </form>
            ) : (
              <form onSubmit={handleProteinGoalSave} className="flex items-center gap-2.5">
                <input
                  type="text"
                  inputMode="numeric"
                  value={proteinGoalInput}
                  onChange={(e) => setProteinGoalInput(e.target.value)}
                  aria-label="Daily protein goal in grams"
                  className={`w-full max-w-[160px] font-mono tabular-nums ${inputClass}`}
                />
                <button type="submit" disabled={busy} className={secondaryBtnClass}>
                  Update Protein
                </button>
              </form>
            )}
          </div>

          <form onSubmit={handleBurnSubmit} className={`${cardClass} p-5 space-y-3`}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[#F8FAFC]">
                <Flame className="h-4 w-4 text-[#2DD4BF]" />
                Log Calories Burned
              </h2>
              <span className="text-xs text-[#CBD5E1]">Manual entry</span>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <input
                type="text"
                inputMode="numeric"
                value={burnCaloriesInput}
                onChange={(e) => setBurnCaloriesInput(e.target.value)}
                placeholder="350"
                aria-label="Calories burned"
                className={`w-24 font-mono tabular-nums ${inputClass}`}
              />
              <select
                value={burnSourceInput}
                onChange={(e) => setBurnSourceInput(e.target.value)}
                aria-label="Burn source"
                className={`flex-1 min-w-[150px] ${inputClass}`}
              >
                {BURN_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={busy} className={secondaryBtnClass}>
                Add Burn
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
