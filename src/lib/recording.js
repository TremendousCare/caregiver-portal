/**
 * Build an authenticated URL for the call-recording Edge Function.
 *
 * The <audio> element cannot send custom Authorization headers,
 * so we pass the Supabase JWT as a query parameter instead.
 * The Edge Function validates it server-side.
 *
 * @param {string} recordingId - RingCentral recording ID
 * @param {string} accessToken - Supabase session access token
 * @returns {string} Full URL for audio playback
 */
export function buildRecordingUrl(recordingId, accessToken) {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  return `${supabaseUrl}/functions/v1/call-recording?recordingId=${encodeURIComponent(recordingId)}&token=${encodeURIComponent(accessToken)}`;
}
