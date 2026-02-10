import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function anthropicProxy() {
  let apiKey;
  return {
    name: 'anthropic-proxy',
    configureServer(server) {
      const env = loadEnv('', process.cwd(), '');
      apiKey = env.ANTHROPIC_API_KEY || '';

      server.middlewares.use('/api/chat', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        if (!apiKey) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set. Add it to your .env file.' }));
          return;
        }

        let body = '';
        for await (const chunk of req) body += chunk;

        try {
          const parsed = JSON.parse(body);
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: parsed.model || 'claude-sonnet-4-5-20250929',
              max_tokens: parsed.max_tokens || 1024,
              system: parsed.system || '',
              messages: parsed.messages || [],
            }),
          });

          const data = await response.json();
          res.statusCode = response.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), anthropicProxy()],
  server: {
    port: 3000,
    open: true,
  },
});
