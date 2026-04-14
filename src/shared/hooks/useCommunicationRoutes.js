import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';

/**
 * Loads active communication_routes once and exposes helpers for smart-default
 * selection based on a set of caregivers.
 *
 * Usage:
 *   const { routes, configuredRoutes, showSelector, smartDefaultCategoryFor, isRouteConfigured } = useCommunicationRoutes();
 *   const defaultCategory = smartDefaultCategoryFor(selectedCaregivers);
 *
 * The hook returns:
 *   - routes: all active routes, including unconfigured ones (shown disabled in UIs)
 *   - configuredRoutes: subset where both sms_from_number and sms_vault_secret_name are set
 *   - showSelector: true when 2+ routes are configured (single-route or empty accounts hide the chip)
 *   - smartDefaultCategoryFor(caregivers): returns a category string or null given a caregiver array
 *   - isRouteConfigured(route): helper to check if a route has phone + JWT
 *
 * Falls back gracefully if the fetch errors — routes stays empty and the UI
 * falls through to the Edge Function's legacy env-var path.
 */
export function useCommunicationRoutes() {
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('communication_routes')
          .select('category, label, is_default, sms_from_number, sms_vault_secret_name, sort_order')
          .eq('is_active', true)
          .order('sort_order', { ascending: true });
        if (error) throw error;
        if (cancelled) return;
        setRoutes(data || []);
      } catch (err) {
        console.warn('[useCommunicationRoutes] Failed to load routes:', err);
        // Leave routes as [] — UIs hide the selector, Edge Function uses legacy path.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const isRouteConfigured = useCallback(
    (r) => !!(r && r.sms_vault_secret_name && r.sms_from_number),
    [],
  );

  const configuredRoutes = useMemo(
    () => routes.filter(isRouteConfigured),
    [routes, isRouteConfigured],
  );

  // Compute a smart default given a set of caregivers. Rules:
  //   1. If ≥70% of the caregivers are in onboarding (no employmentStatus or
  //      === 'onboarding') AND an 'onboarding' route is configured → return it.
  //   2. Otherwise → return the is_default route (if configured).
  //   3. Fallback → first configured route (alphabetical by sort_order).
  //   4. No routes configured → null.
  const smartDefaultCategoryFor = useCallback((caregivers = []) => {
    if (!routes.length) return null;

    const isOnboardingHeavy = (() => {
      if (caregivers.length === 0) return false;
      const onboardingCount = caregivers.filter(
        (cg) => !cg.employmentStatus || cg.employmentStatus === 'onboarding',
      ).length;
      return onboardingCount / caregivers.length >= 0.7;
    })();

    if (isOnboardingHeavy) {
      const onboarding = routes.find(
        (r) => r.category === 'onboarding' && isRouteConfigured(r),
      );
      if (onboarding) return onboarding.category;
    }

    const def = routes.find((r) => r.is_default && isRouteConfigured(r));
    if (def) return def.category;

    const firstConfigured = routes.find(isRouteConfigured);
    return firstConfigured?.category || null;
  }, [routes, isRouteConfigured]);

  // Only show the selector chip when there are 2+ configured routes — a single
  // route means there's no decision to make.
  const showSelector = configuredRoutes.length >= 2;

  return {
    routes,
    configuredRoutes,
    loading,
    showSelector,
    smartDefaultCategoryFor,
    isRouteConfigured,
  };
}
