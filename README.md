# Tremendous Care — Caregiver Portal

A React application for managing caregiver onboarding through a 5-phase pipeline.

## Quick Start (Local Development)

```bash
# 1. Install dependencies
npm install

# 2. Start development server
npm run dev

# 3. Open http://localhost:3000
# Login code: TremendousCare2025
```

The app works immediately with localStorage (single-user mode).

## Setting Up Supabase (Shared Team Data)

To enable shared data across your team:

### 1. Create a Supabase project
- Go to [supabase.com](https://supabase.com) and create a free account
- Click "New Project" and give it a name (e.g., "tremendous-care")
- Wait ~2 minutes for it to provision

### 2. Create the database tables
- In your Supabase dashboard, go to **SQL Editor**
- Paste the contents of `supabase/schema.sql` and click **Run**

### 3. Configure environment variables
- Copy `.env.example` to `.env`:
  ```bash
  cp .env.example .env
  ```
- In your Supabase dashboard, go to **Settings → API**
- Copy **Project URL** → paste as `VITE_SUPABASE_URL`
- Copy **anon/public key** → paste as `VITE_SUPABASE_ANON_KEY`

### 4. Restart the dev server
```bash
npm run dev
```

The app will automatically detect Supabase and use it for all data storage.

## Deploying to Vercel

```bash
# 1. Install Vercel CLI (one time)
npm i -g vercel

# 2. Deploy
vercel

# 3. Add environment variables in the Vercel dashboard
#    (Settings → Environment Variables → add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY)
```

Or connect your GitHub repo to Vercel for automatic deployments on every push.

## Project Structure

```
src/
├── main.jsx              # App entry point
├── App.jsx               # Root component, state management, routing
├── lib/
│   ├── constants.js      # Phases, tasks, scripts, board columns
│   ├── storage.js        # Storage abstraction (localStorage + Supabase)
│   ├── supabase.js       # Supabase client
│   ├── utils.js          # Phase progress, green light, date helpers
│   ├── actionEngine.js   # Action items / urgency engine
│   └── export.js         # CSV export
├── components/
│   ├── AuthGate.jsx      # Login screen
│   ├── Sidebar.jsx       # Navigation sidebar
│   ├── Dashboard.jsx     # Pipeline dashboard with stats & cards
│   ├── KanbanBoard.jsx   # Kanban board + orientation banner
│   ├── AddCaregiver.jsx  # New caregiver form
│   ├── CaregiverDetail.jsx # Full caregiver profile & tasks
│   └── Toast.jsx         # Toast notifications
├── styles/
│   ├── theme.js          # All style objects
│   └── global.css        # Animations, hover states, scrollbar
```

## Version History

- **v4.2** — Current version. Collapsible action items, animations, visual overhaul.
- See session handoff document for full changelog.
