export async function sendMessage(messages, systemPrompt) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error?.message || data.error);
  }

  if (data.content?.[0]?.text) {
    return data.content[0].text;
  }

  throw new Error('Unexpected response format');
}
