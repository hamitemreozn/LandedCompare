/**
 * The icon convention: one curated re-export surface over `lucide-react`,
 * keyed by product concept rather than by the upstream icon's own name.
 * Screens import `Icons.dashboard`, not `LayoutDashboard` — so the mapping
 * from concept to glyph lives in exactly one place and can change without
 * touching call sites. Nothing in the existing navigation uses these yet
 * (Phase 12.7 wires the shell); this establishes the convention other
 * primitives and Phase 12.7 build on. See docs/DESIGN_SYSTEM.md.
 *
 * All icon-only controls must carry an accessible name (`aria-label` on the
 * control, not on the icon) — the icon itself is always decorative.
 */
import {
  LayoutDashboard,
  Package,
  Truck,
  Users,
  UserCog,
  FileText,
  ShoppingCart,
  Boxes,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeftRight,
  Building2,
  Settings,
  User,
  LogOut,
  Menu,
  X,
  ChevronDown,
  ChevronRight,
  Search,
  Filter,
  Plus,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Check,
} from 'lucide-react'

export const Icons = {
  dashboard: LayoutDashboard,
  products: Package,
  suppliers: Truck,
  customers: Users,
  customerStatuses: UserCog,
  quotes: FileText,
  purchasing: ShoppingCart,
  inventory: Boxes,
  inbound: ArrowDownToLine,
  outbound: ArrowUpFromLine,
  switchOrganization: ArrowLeftRight,
  organization: Building2,
  settings: Settings,
  user: User,
  logout: LogOut,
  menu: Menu,
  close: X,
  chevron: ChevronDown,
  chevronRight: ChevronRight,
  search: Search,
  filter: Filter,
  add: Plus,
  edit: Pencil,
  collapseSidebar: PanelLeftClose,
  expandSidebar: PanelLeftOpen,
  check: Check,
} as const

export type IconName = keyof typeof Icons
