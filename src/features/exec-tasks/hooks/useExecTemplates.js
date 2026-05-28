import { useCallback, useEffect, useState } from 'react';
import { supabase, getOrgClaims } from '../../../lib/supabase';
import {
  fetchTemplates,
  updateTemplate as updateTemplateQuery,
  createTemplate as createTemplateQuery,
} from '../lib/templatesQueries';

export function useExecTemplates() {
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await fetchTemplates(supabase);
    if (r.error) {
      setError(r.error);
      setTemplates([]);
    } else {
      setTemplates(r.data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateTemplate = useCallback(async (id, patch) => {
    setSubmitting(true);
    setError(null);
    try {
      const template = templates.find((t) => t.id === id);
      const r = await updateTemplateQuery(supabase, { id, template, patch });
      if (r.error) throw r.error;
      await load();
      return r.data;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, [templates, load]);

  const createTemplate = useCallback(async (draft) => {
    setSubmitting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { orgId } = getOrgClaims(session);
      const r = await createTemplateQuery(supabase, { orgId, draft });
      if (r.error) throw r.error;
      await load();
      return r.data;
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSubmitting(false);
    }
  }, [load]);

  return { loading, submitting, templates, error, refresh: load, updateTemplate, createTemplate };
}
