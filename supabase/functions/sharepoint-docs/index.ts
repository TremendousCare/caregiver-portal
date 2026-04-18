import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
// ─── Microsoft Graph Auth ───────────────────────────────────
async function getMicrosoftAccessToken() {
  const tenantId = Deno.env.get('MICROSOFT_TENANT_ID');
  const clientId = Deno.env.get('MICROSOFT_CLIENT_ID');
  const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET');
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default'
  });
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Microsoft token error: ${resp.status} - ${err}`);
  }
  const data = await resp.json();
  return data.access_token;
}
// ─── SharePoint Site/Drive Discovery ────────────────────────
let cachedDriveId = null;
async function getDriveId(token) {
  if (cachedDriveId) return cachedDriveId;
  // Try env var first
  const envDriveId = Deno.env.get('SHAREPOINT_DRIVE_ID');
  if (envDriveId) {
    cachedDriveId = envDriveId;
    return envDriveId;
  }
  // Auto-discover from site URL
  const siteHost = 'themedicalconnection.sharepoint.com';
  const sitePath = '/sites/CaregiverDocuments';
  // Get site ID
  const siteResp = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteHost}:${sitePath}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!siteResp.ok) {
    const err = await siteResp.text();
    throw new Error(`SharePoint site lookup failed: ${siteResp.status} - ${err}`);
  }
  const siteData = await siteResp.json();
  const siteId = siteData.id;
  // Get default document library drive
  const drivesResp = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drives`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!drivesResp.ok) {
    const err = await drivesResp.text();
    throw new Error(`SharePoint drives lookup failed: ${drivesResp.status} - ${err}`);
  }
  const drivesData = await drivesResp.json();
  const drive = drivesData.value?.[0];
  if (!drive) throw new Error('No document library found on SharePoint site');
  cachedDriveId = drive.id;
  return drive.id;
}
// ─── Graph API Helpers ──────────────────────────────────────
async function graphGet(token, path) {
  const resp = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  return {
    ok: resp.ok,
    status: resp.status,
    data: resp.ok ? await resp.json() : null,
    error: resp.ok ? null : await resp.text()
  };
}
async function ensureFolder(token, driveId, folderPath) {
  // Try to get the folder first
  const check = await graphGet(token, `/drives/${driveId}/root:/${folderPath}`);
  if (check.ok) return; // folder exists
  // Create folder path segment by segment
  const segments = folderPath.split('/').filter(Boolean);
  let parentPath = '';
  for (const segment of segments){
    const currentPath = parentPath ? `${parentPath}/${segment}` : segment;
    const exists = await graphGet(token, `/drives/${driveId}/root:/${currentPath}`);
    if (!exists.ok) {
      const parentUrl = parentPath ? `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${parentPath}:/children` : `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children`;
      const createResp = await fetch(parentUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: segment,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail'
        })
      });
      if (!createResp.ok && createResp.status !== 409) {
        const err = await createResp.text();
        throw new Error(`Failed to create folder '${segment}': ${createResp.status} - ${err}`);
      }
    }
    parentPath = currentPath;
  }
}
// ─── Supabase Client ────────────────────────────────────────
function getSupabaseClient() {
  return createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
}
// ─── Document type to onboarding task mapping ───────────────
const DOC_TYPE_TO_TASK = {
  offer_signed: 'offer_signed',
  wage_notice: 'wage_notice',
  direct_deposit: 'direct_deposit',
  i9_form: 'i9_form',
  w4_form: 'w4_form',
  emergency_contact: 'emergency_contact',
  employment_agreement: 'employment_agreement',
  employee_handbook: 'employee_handbook',
  harassment_pamphlet: 'harassment_pamphlet',
  disability_pamphlet: 'disability_pamphlet',
  family_leave_pamphlet: 'family_leave_pamphlet',
  domestic_violence_notice: 'domestic_violence_notice'
};
// ─── Action Handlers ────────────────────────────────────────
async function handleListFiles(params) {
  const { caregiver_id } = params;
  if (!caregiver_id) throw new Error('caregiver_id is required');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('caregiver_documents').select('*').eq('caregiver_id', caregiver_id).order('uploaded_at', {
    ascending: false
  });
  if (error) throw new Error(`DB query failed: ${error.message}`);
  return {
    documents: data || []
  };
}
async function handleUploadFile(params) {
  const { caregiver_id, document_type, file_name, file_content_base64 } = params;
  if (!caregiver_id || !document_type || !file_name || !file_content_base64) {
    throw new Error('caregiver_id, document_type, file_name, and file_content_base64 are required');
  }
  const supabase = getSupabaseClient();
  // Get caregiver info for folder name
  const { data: cg, error: cgErr } = await supabase.from('caregivers').select('first_name, last_name').eq('id', caregiver_id).single();
  if (cgErr || !cg) throw new Error(`Caregiver not found: ${cgErr?.message}`);
  const folderName = `${cg.first_name} ${cg.last_name} - ${caregiver_id}`;
  const folderPath = `Caregivers/${folderName}`;
  // Get Microsoft token and drive
  const token = await getMicrosoftAccessToken();
  const driveId = await getDriveId(token);
  // Ensure folder exists
  await ensureFolder(token, driveId, folderPath);
  // Decode base64 and upload
  const fileBytes = Uint8Array.from(atob(file_content_base64), (c)=>c.charCodeAt(0));
  const uploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${folderPath}/${file_name}:/content`;
  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream'
    },
    body: fileBytes
  });
  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    throw new Error(`SharePoint upload failed: ${uploadResp.status} - ${err}`);
  }
  const spFile = await uploadResp.json();
  // Insert record in DB
  const { data: doc, error: docErr } = await supabase.from('caregiver_documents').insert({
    caregiver_id,
    document_type,
    file_name,
    sharepoint_file_id: spFile.id,
    sharepoint_web_url: spFile.webUrl,
    file_size: spFile.size || fileBytes.length,
    uploaded_by: params.uploaded_by || ''
  }).select().single();
  if (docErr) throw new Error(`DB insert failed: ${docErr.message}`);
  // Auto-complete the matching onboarding task
  const taskId = DOC_TYPE_TO_TASK[document_type];
  if (taskId) {
    const { data: cgFull } = await supabase.from('caregivers').select('tasks').eq('id', caregiver_id).single();
    if (cgFull) {
      const tasks = cgFull.tasks || {};
      if (!tasks[taskId]) {
        tasks[taskId] = true;
        await supabase.from('caregivers').update({
          tasks
        }).eq('id', caregiver_id);
      }
    }
  }
  return {
    document: doc,
    sharepoint_url: spFile.webUrl
  };
}
async function handleGetDownloadUrl(params) {
  const { doc_id } = params;
  if (!doc_id) throw new Error('doc_id is required');
  const supabase = getSupabaseClient();
  const { data: doc, error } = await supabase.from('caregiver_documents').select('sharepoint_file_id').eq('id', doc_id).single();
  if (error || !doc) throw new Error(`Document not found: ${error?.message}`);
  if (!doc.sharepoint_file_id) throw new Error('No SharePoint file ID associated with this document');
  const token = await getMicrosoftAccessToken();
  const driveId = await getDriveId(token);
  // Get a temporary download URL
  const resp = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${doc.sharepoint_file_id}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Graph API error: ${resp.status} - ${err}`);
  }
  const item = await resp.json();
  return {
    download_url: item['@microsoft.graph.downloadUrl'],
    web_url: item.webUrl
  };
}
async function handleDeleteFile(params) {
  const { doc_id } = params;
  if (!doc_id) throw new Error('doc_id is required');
  const supabase = getSupabaseClient();
  const { data: doc, error } = await supabase.from('caregiver_documents').select('*').eq('id', doc_id).single();
  if (error || !doc) throw new Error(`Document not found: ${error?.message}`);
  // Delete from SharePoint
  if (doc.sharepoint_file_id) {
    const token = await getMicrosoftAccessToken();
    const driveId = await getDriveId(token);
    const delResp = await fetch(`https://graph.microsoft.com/v1.0/drives/${driveId}/items/${doc.sharepoint_file_id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    // 204 = success, 404 = already gone (both OK)
    if (!delResp.ok && delResp.status !== 404) {
      const err = await delResp.text();
      throw new Error(`SharePoint delete failed: ${delResp.status} - ${err}`);
    }
  }
  // Remove from DB
  const { error: dbErr } = await supabase.from('caregiver_documents').delete().eq('id', doc_id);
  if (dbErr) throw new Error(`DB delete failed: ${dbErr.message}`);
  // Un-complete the matching onboarding task if no other doc of same type exists
  if (doc.document_type && DOC_TYPE_TO_TASK[doc.document_type]) {
    const { data: remaining } = await supabase.from('caregiver_documents').select('id').eq('caregiver_id', doc.caregiver_id).eq('document_type', doc.document_type);
    if (!remaining || remaining.length === 0) {
      const taskId = DOC_TYPE_TO_TASK[doc.document_type];
      const { data: cgFull } = await supabase.from('caregivers').select('tasks').eq('id', doc.caregiver_id).single();
      if (cgFull) {
        const tasks = cgFull.tasks || {};
        if (tasks[taskId]) {
          tasks[taskId] = false;
          await supabase.from('caregivers').update({
            tasks
          }).eq('id', doc.caregiver_id);
        }
      }
    }
  }
  return {
    success: true,
    deleted_doc_id: doc_id
  };
}
// ─── Main Handler ───────────────────────────────────────────
Deno.serve(async (req)=>{
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    const { action, ...params } = await req.json();
    let result;
    switch(action){
      case 'list_files':
        result = await handleListFiles(params);
        break;
      case 'upload_file':
        result = await handleUploadFile(params);
        break;
      case 'get_download_url':
        result = await handleGetDownloadUrl(params);
        break;
      case 'delete_file':
        result = await handleDeleteFile(params);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    return new Response(JSON.stringify(result), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('sharepoint-docs error:', err);
    return new Response(JSON.stringify({
      error: err.message || 'Internal error'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
