import type { AuthContext } from '../types';
import { hasPermission } from './rbac';

/**
 * The dashboard trees from the module spec, expressed as data.
 *
 * The Flutter app asks GET /api/me/dashboard and renders whatever comes back,
 * so navigation and permissions can never drift apart: an item is only present
 * if the caller actually holds the permission behind it. Adding a screen in a
 * later module means adding an entry here, not shipping a new client build.
 */
export interface NavItem {
  key: string;
  label: string;
  icon: string;
  route: string;
  /** Any one of these is enough to see the item. Empty means always visible. */
  permissions?: string[];
  children?: NavItem[];
}

const SUPER_ADMIN_NAV: NavItem[] = [
  { key: 'overview',   label: 'Overview',              icon: 'dashboard',  route: '/admin' },
  { key: 'users',      label: 'Users',                 icon: 'people',     route: '/admin/users',      permissions: ['users.read'] },
  { key: 'teachers',   label: 'Teachers',              icon: 'school',     route: '/admin/teachers',   permissions: ['teachers.read'] },
  { key: 'students',   label: 'Students',              icon: 'backpack',   route: '/admin/students',   permissions: ['students.read'] },
  { key: 'partners',   label: 'Partners',              icon: 'handshake',  route: '/admin/partners',   permissions: ['partners.read'] },
  { key: 'agreements', label: 'Partnership Agreements',icon: 'gavel',      route: '/admin/agreements', permissions: ['agreements.read'] },
  { key: 'revenue',    label: 'Revenue',               icon: 'trending_up',route: '/admin/revenue',    permissions: ['revenue.read'] },
  { key: 'pricing',    label: 'Pricing',               icon: 'sell',       route: '/admin/pricing',    permissions: ['pricing.manage'] },
  { key: 'payments',   label: 'Payments',              icon: 'payments',   route: '/admin/payments',   permissions: ['payments.read'] },
  { key: 'reports',    label: 'Reports',               icon: 'bar_chart',  route: '/admin/reports',    permissions: ['reports.read', 'reports.financial.read'] },
  { key: 'approvals',  label: 'Approvals',             icon: 'task_alt',   route: '/admin/approvals',  permissions: ['approvals.read'] },
  { key: 'audit',      label: 'Audit Logs',            icon: 'history',    route: '/admin/audit',      permissions: ['audit.read'] },
  { key: 'settings',   label: 'Settings',              icon: 'settings',   route: '/admin/settings',   permissions: ['settings.read'] },
];

const DEPUTY_NAV: NavItem[] = [
  { key: 'overview',   label: 'Overview',           icon: 'dashboard', route: '/deputy' },
  { key: 'users',      label: 'Users',              icon: 'people',    route: '/deputy/users',    permissions: ['users.read'] },
  { key: 'teachers',   label: 'Teachers',           icon: 'school',    route: '/deputy/teachers', permissions: ['teachers.read'] },
  { key: 'students',   label: 'Students',           icon: 'backpack',  route: '/deputy/students', permissions: ['students.read'] },
  { key: 'content',    label: 'Content Review',     icon: 'fact_check',route: '/deputy/content',  permissions: ['content.read', 'content.review'] },
  { key: 'reports',    label: 'Reports',            icon: 'bar_chart', route: '/deputy/reports',  permissions: ['reports.read'] },
  { key: 'assigned',   label: 'Assigned Management',icon: 'assignment',route: '/deputy/assigned' },
];

const PARTNER_NAV: NavItem[] = [
  { key: 'overview',     label: 'Overview',            icon: 'dashboard',  route: '/partner' },
  { key: 'agreement',    label: 'Partnership Agreement',icon: 'gavel',     route: '/partner/agreement',    permissions: ['partner.self.agreements.read'] },
  { key: 'revenue',      label: 'Revenue',             icon: 'trending_up',route: '/partner/revenue',      permissions: ['partner.self.revenue.read'] },
  { key: 'share',        label: 'My Share',            icon: 'pie_chart',  route: '/partner/share',        permissions: ['partner.self.revenue.read'] },
  { key: 'distributions',label: 'Distribution History',icon: 'history',    route: '/partner/distributions',permissions: ['partner.self.revenue.read'] },
  { key: 'statements',   label: 'Statements',          icon: 'receipt',    route: '/partner/statements',   permissions: ['partner.self.statements.read'] },
  { key: 'profile',      label: 'Profile',             icon: 'person',     route: '/partner/profile' },
];

// Placeholders so the client has a home to land on. Modules 4-9 fill these in.
const TEACHER_NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', icon: 'dashboard', route: '/teacher' },
  { key: 'profile',  label: 'Profile',  icon: 'person',    route: '/teacher/profile' },
];

const STUDENT_NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', icon: 'dashboard', route: '/student' },
  { key: 'profile',  label: 'Profile',  icon: 'person',    route: '/student/profile' },
];

/** Highest-authority role first, so a Super Admin who is also a Partner lands on /admin. */
const ROLE_DASHBOARDS: { role: string; home: string; nav: NavItem[] }[] = [
  { role: 'SUPER_ADMIN',        home: '/admin',   nav: SUPER_ADMIN_NAV },
  { role: 'DEPUTY_SUPER_ADMIN', home: '/deputy',  nav: DEPUTY_NAV },
  { role: 'PARTNER',            home: '/partner', nav: PARTNER_NAV },
  { role: 'TEACHER',            home: '/teacher', nav: TEACHER_NAV },
  { role: 'STUDENT',            home: '/student', nav: STUDENT_NAV },
];

function visible(auth: AuthContext, items: NavItem[]): NavItem[] {
  return items
    .filter((item) => !item.permissions?.length || item.permissions.some((code) => hasPermission(auth, code)))
    .map((item) => (item.children ? { ...item, children: visible(auth, item.children) } : item));
}

export function buildDashboard(auth: AuthContext) {
  const primary = ROLE_DASHBOARDS.find((entry) => auth.roles.includes(entry.role));

  if (!primary) {
    return { home: '/', primaryRole: null, nav: [] as NavItem[], availableDashboards: [] as string[] };
  }

  return {
    home: primary.home,
    primaryRole: primary.role,
    nav: visible(auth, primary.nav),
    // A user with several roles can switch; the client offers these as tabs.
    availableDashboards: ROLE_DASHBOARDS.filter((entry) => auth.roles.includes(entry.role)).map((entry) => entry.home),
  };
}
