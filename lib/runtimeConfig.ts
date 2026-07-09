// D:\APPden\SkorLig\mobile\lib\runtimeConfig.ts
"use strict";

import { useEffect, useState } from "react";
import Constants from "expo-constants";

const API_BASE =
  (Constants?.expoConfig?.extra?.apiBase as string) ||
  process.env.EXPO_PUBLIC_API_BASE ||
  "http://192.168.43.245:4102";

/**
 * Backend /api/config cevabı
 */
export type FeaturesConfig = {
  mode: "GS_ONLY" | "MULTI_LEAGUE" | string;
  showProfile: boolean;
  showLeaderboard: boolean;
  enableCoupons: boolean;
};

export type ScoringConfig = {
  startBalance: number;
  useProbabilityEngine: boolean;
  K_outcome: number;
  epsilon: number;
  unknownPenaltyPct?: number;
};

export type RuntimeMode = {
  profile: string; // DEV_4_TEAMS | TR_30_TEAMS | GLOBAL_100_TEAMS | GLOBAL_456_TEAMS | ...
  maxTeams?: number;
  maxLeagues?: number;
  notes?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
};

export type ApiConfigPayload = {
  ok: boolean;
  config: {
    features: FeaturesConfig;
    scoring: ScoringConfig;
  };
  runtimeMode?: RuntimeMode | null;
  from: "settings.json" | "default" | string;
};

export type RuntimeStage =
  | {
      profile: string;
      maxTeams: number | null;
      maxLeagues: number | null;
      label: string;
      level: "DEV" | "TR" | "GLOBAL_LIGHT" | "GLOBAL_FULL" | "CUSTOM";
    }
  | null;

export type RuntimeConfigState = {
  loading: boolean;
  error: string | null;
  features: FeaturesConfig;
  scoring: ScoringConfig;
  runtimeMode: RuntimeMode | null;
  stage: RuntimeStage;
};

/**
 * Backend'den /api/config okuyup,
 * runtimeMode.profile → stage haritası çıkaran küçük helper.
 */
export async function fetchRuntimeConfig(): Promise<RuntimeConfigState> {
  const defaultFeatures: FeaturesConfig = {
    mode: "GS_ONLY",
    showProfile: true,
    showLeaderboard: true,
    enableCoupons: false,
  };

  const defaultScoring: ScoringConfig = {
    startBalance: 500,
    useProbabilityEngine: false,
    K_outcome: 3,
    epsilon: 0.05,
    unknownPenaltyPct: 0.1,
  };

  try {
    const res = await fetch(`${API_BASE}/api/config`);
    const j = (await res.json()) as ApiConfigPayload;

    if (!j || !j.ok || !j.config) {
      return {
        loading: false,
        error: j && !j.ok ? "CONFIG_NOT_OK" : "CONFIG_FETCH_FAILED",
        features: defaultFeatures,
        scoring: defaultScoring,
        runtimeMode: null,
        stage: null,
      };
    }

    const features = {
      ...defaultFeatures,
      ...(j.config.features || {}),
    } as FeaturesConfig;

    const scoring = {
      ...defaultScoring,
      ...(j.config.scoring || {}),
    } as ScoringConfig;

    const runtimeMode: RuntimeMode | null =
      (j.runtimeMode as RuntimeMode) || null;

    const stage = mapRuntimeStage(runtimeMode);

    return {
      loading: false,
      error: null,
      features,
      scoring,
      runtimeMode,
      stage,
    };
  } catch (e: any) {
    return {
      loading: false,
      error: String(e?.message || e || "CONFIG_FETCH_ERROR"),
      features: defaultFeatures,
      scoring: defaultScoring,
      runtimeMode: null,
      stage: null,
    };
  }
}

/**
 * runtimeMode.profile → frontende anlamlı label / seviyeye map eder.
 * Backend’teki preset’lerle birebir uyumlu.
 */
export function mapRuntimeStage(mode: RuntimeMode | null | undefined): RuntimeStage {
  if (!mode) {
    return null;
  }

  const profile = String(mode.profile || "").toUpperCase();
  const maxTeams =
    typeof mode.maxTeams === "number" ? mode.maxTeams : null;
  const maxLeagues =
    typeof mode.maxLeagues === "number" ? mode.maxLeagues : null;

  if (profile === "DEV_4_TEAMS") {
    return {
      profile,
      maxTeams: maxTeams ?? 4,
      maxLeagues: maxLeagues ?? 1,
      label: "4 takımlı geliştirme modu",
      level: "DEV",
    };
  }
  if (profile === "TR_30_TEAMS") {
    return {
      profile,
      maxTeams: maxTeams ?? 30,
      maxLeagues: maxLeagues ?? 1,
      label: "Türkiye ligi testi (≈30 takım)",
      level: "TR",
    };
  }
  if (profile === "GLOBAL_100_TEAMS") {
    return {
      profile,
      maxTeams: maxTeams ?? 100,
      maxLeagues: maxLeagues ?? 5,
      label: "Kısıtlı global test modu (≈100 takım)",
      level: "GLOBAL_LIGHT",
    };
  }
  if (profile === "GLOBAL_456_TEAMS") {
    return {
      profile,
      maxTeams: maxTeams ?? 456,
      maxLeagues: maxLeagues ?? 20,
      label: "Tam global yüksek yük modu",
      level: "GLOBAL_FULL",
    };
  }

  // Bilinmeyen profiller için generic
  return {
    profile,
    maxTeams,
    maxLeagues,
    label: mode.notes || `Custom profil: ${profile}`,
    level: "CUSTOM",
  };
}

/**
 * React hook: komponent içinde direkt kullanmak için.
 *
 * Örnek:
 *   const { loading, features, runtimeMode, stage } = useRuntimeConfig();
 */
export function useRuntimeConfig(): RuntimeConfigState {
  const [state, setState] = useState<RuntimeConfigState>({
    loading: true,
    error: null,
    features: {
      mode: "GS_ONLY",
      showProfile: true,
      showLeaderboard: true,
      enableCoupons: false,
    },
    scoring: {
      startBalance: 500,
      useProbabilityEngine: false,
      K_outcome: 3,
      epsilon: 0.05,
      unknownPenaltyPct: 0.1,
    },
    runtimeMode: null,
    stage: null,
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const next = await fetchRuntimeConfig();
      if (!cancelled) {
        setState(next);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
