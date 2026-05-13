import {
  Hospital,
  Phone,
  Mail,
  MessageSquare,
  Gift,
  Mic,
  Star,
  StickyNote,
  Circle,
} from 'lucide-react';

const MAP = {
  visit:             Hospital,
  call:              Phone,
  email:             Mail,
  sms:               MessageSquare,
  drop_off:          Gift,
  event:             Mic,
  referral_received: Star,
  note:              StickyNote,
};

export function ActivityTypeIcon({ type, size = 18, className, strokeWidth = 1.75 }) {
  const Cmp = MAP[type] ?? Circle;
  return <Cmp size={size} className={className} strokeWidth={strokeWidth} aria-hidden />;
}

export const ACTIVITY_TYPE_ICON_TYPES = Object.keys(MAP);
