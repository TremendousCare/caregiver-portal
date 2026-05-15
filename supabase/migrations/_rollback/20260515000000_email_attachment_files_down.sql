-- Rollback for the email-attachments migration.
--
-- Drops the table, the storage bucket, and all related RLS policies.
-- Storage objects in the bucket must be deleted FIRST (Supabase
-- requires the bucket to be empty before drop). The DELETE here is
-- guarded by service_role; running this script as authenticated will
-- fail on the storage.objects DELETE — that's intentional.

DROP POLICY IF EXISTS "email_attachment_files_staff_read"   ON public.email_attachment_files;
DROP POLICY IF EXISTS "email_attachment_files_admin_insert" ON public.email_attachment_files;
DROP POLICY IF EXISTS "email_attachment_files_admin_update" ON public.email_attachment_files;
DROP POLICY IF EXISTS "email_attachment_files_admin_delete" ON public.email_attachment_files;

DROP TABLE IF EXISTS public.email_attachment_files;

DROP POLICY IF EXISTS "email_attachments_staff_read"    ON storage.objects;
DROP POLICY IF EXISTS "email_attachments_admin_insert"  ON storage.objects;
DROP POLICY IF EXISTS "email_attachments_admin_update"  ON storage.objects;
DROP POLICY IF EXISTS "email_attachments_admin_delete"  ON storage.objects;
DROP POLICY IF EXISTS "email_attachments_service_role"  ON storage.objects;

DELETE FROM storage.objects WHERE bucket_id = 'email-attachments';
DELETE FROM storage.buckets WHERE id = 'email-attachments';
