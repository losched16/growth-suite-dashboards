// Canonical parent-portal nav items. Kept in sync with the portal's
// app/(portal)/layout.tsx NAV_ITEMS (the two repos don't share code).
// Used by the admin + school "Portal menus" settings to render on/off
// toggles. The school's OFF items are stored in
// school_branding.portal_hidden_nav and the portal filters its nav by them.
export const PORTAL_NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/home', label: 'Home' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/attendance', label: 'Attendance' },
  { href: '/family', label: 'Family' },
  { href: '/forms-v2', label: 'Forms' },
  { href: '/resources', label: 'Important Documents' },
  { href: '/forms', label: 'Documents' },
  { href: '/tuition', label: 'Tuition' },
  { href: '/billing', label: 'Invoices' },
  { href: '/financial-aid', label: 'Financial Aid' },
  { href: '/products', label: 'School Store' },
  { href: '/help', label: 'Help' },
];
