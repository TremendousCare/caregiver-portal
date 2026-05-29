-- Rollback for 20260601020000_restrict_caregiver_documents_to_admin.sql
--
-- Removes the RESTRICTIVE admin/owner gate on caregiver_documents,
-- restoring the prior behavior where the existing PERMISSIVE policies
-- (caregiver_documents_staff_all + tenant_isolation_caregiver_documents_*)
-- alone govern access — i.e. all staff including 'member' regain access.
--
-- Because the forward migration is purely additive (it only ADDED a
-- RESTRICTIVE policy and modified nothing else), the rollback is a single
-- DROP. The permissive policies were never touched and stay in place, so
-- org isolation is never weakened by this rollback.
--
-- This file lives in the underscored _rollback directory and is NOT
-- auto-applied by the deploy workflow. Run manually only if the
-- restriction must be reverted. Idempotent (DROP IF EXISTS).

DROP POLICY IF EXISTS restrict_caregiver_documents_to_admins ON public.caregiver_documents;
