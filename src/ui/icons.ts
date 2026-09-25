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
  Building2,
  Settings,
  User,
  LogOut,
  Menu,
  ChevronDown,
  Search,
  Filter,
  Plus,
  Pencil,
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
  organization: Building2,
  settings: Settings,
  user: User,
  logout: LogOut,
  menu: Menu,
  chevron: ChevronDown,
  search: Search,
  filter: Filter,
  add: Plus,
  edit: Pencil,
} as const

export type IconName = keyof typeof Icons
