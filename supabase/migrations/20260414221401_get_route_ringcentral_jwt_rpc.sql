CREATE OR REPLACE FUNCTION public.get_route_ringcentral_jwt(p_category TEXT)
RETURNS TABLE (
  sms_from_number TEXT,
  jwt             TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_phone        TEXT;
  v_secret_name  TEXT;
  v_jwt          TEXT;
BEGIN
  SELECT cr.sms_from_number, cr.sms_vault_secret_name
    INTO v_phone, v_secret_name
  FROM public.communication_routes cr
  WHERE cr.category = p_category AND cr.is_active = true;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_secret_name IS NULL THEN
    RETURN QUERY SELECT v_phone, NULL::TEXT;
    RETURN;
  END IF;

  SELECT vds.decrypted_secret INTO v_jwt
  FROM vault.decrypted_secrets vds
  WHERE vds.name = v_secret_name;

  RETURN QUERY SELECT v_phone, v_jwt;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_route_ringcentral_jwt(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_route_ringcentral_jwt(TEXT) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.get_route_ringcentral_jwt(TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_route_ringcentral_jwt(TEXT) TO service_role;
