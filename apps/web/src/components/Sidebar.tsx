/**
 * Sidebar — primary navigation rail.
 *
 * Home / Agentic Apps / Agents / Brain / Assets.
 * (Packages lives in the header profile menu; Extensions open as a modal from
 * the Apps hub header and each workflow canvas toolbar — they're a
 * workflow-building block, not a top-level destination.)
 * Live badges on Agents (live count).
 * Auto-collapse when ChatPanel is docked.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import {
  Home as HomeIcon,
  Bot,
  Brain as BrainIcon,
  LayoutGrid as AppsIcon,
  Library as AssetsIcon,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useWorkspaceChromeData } from '../lib/workspaceChromeData';
import { useChatPanelStore } from './chat/ChatPanelStore';

interface NavItem {
  to: string;
  labelKey: 'navigation.home' | 'navigation.apps' | 'navigation.agents' | 'navigation.brain' | 'navigation.assets';
  title?: string;
  icon: LucideIcon;
  badge?: 'liveAgents';
}

const NAV: NavItem[] = [
  { to: '/home', labelKey: 'navigation.home', title: 'Home', icon: HomeIcon },
  { to: '/apps', labelKey: 'navigation.apps', title: 'Apps', icon: AppsIcon },
  { to: '/agents', labelKey: 'navigation.agents', title: 'Agents', icon: Bot, badge: 'liveAgents' },
  { to: '/brain', labelKey: 'navigation.brain', title: 'Brain', icon: BrainIcon },
  { to: '/assets', labelKey: 'navigation.assets', title: 'Assets', icon: AssetsIcon },
];

const STORAGE_KEY = 'agentis.sidebar.collapsed';

export function Sidebar() {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  const { counts } = useWorkspaceChromeData();
  const chatState = useChatPanelStore((s) => s.state);

  useEffect(() => {
    if (chatState === 'docked') setCollapsed(true);
  }, [chatState]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  return (
    <>
      <aside
      data-agentis-sidebar
      className={clsx(
        'flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <nav className="flex-1 overflow-y-auto py-3">
        <ul className="flex flex-col gap-0.5 px-2">
          {NAV.map((item) => (
            <SidebarLink key={item.to} item={item} collapsed={collapsed} counts={counts} />
          ))}
        </ul>
      </nav>

      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex h-9 shrink-0 items-center justify-center gap-2 border-t border-line text-[11px] text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
        title={collapsed ? t('navigation.expandSidebar') : t('navigation.collapseSidebar')}
      >
        {collapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
        {!collapsed && <span>{t('navigation.collapse')}</span>}
      </button>
      </aside>
      <nav data-agentis-mobile-nav aria-label="Primary navigation">
        {NAV.map((item) => <MobileNavigationLink key={item.to} item={item} />)}
      </nav>
    </>
  );
}

function MobileNavigationLink({ item }: { item: NavItem }) {
  const { t } = useTranslation();
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      title={item.title ?? t(item.labelKey)}
      className={({ isActive }) => clsx('agentis-mobile-nav__link', isActive && 'agentis-mobile-nav__link--active')}
    >
      <Icon size={18} strokeWidth={1.8} />
      <span>{t(item.labelKey)}</span>
    </NavLink>
  );
}

function SidebarLink({
  item,
  collapsed,
  counts,
}: {
  item: NavItem;
  collapsed: boolean;
  counts: ReturnType<typeof useWorkspaceChromeData>['counts'];
}) {
  const { t } = useTranslation();
  const Icon = item.icon;
  const badge = item.badge ? counts[item.badge] : 0;
  return (
    <li>
      <NavLink
        to={item.to}
        title={item.title ?? t(item.labelKey)}
        className={({ isActive }) =>
          clsx(
            'group relative flex items-center gap-2.5 rounded-nav px-2.5 py-2 text-[13px] transition-colors',
            collapsed && 'justify-center',
            isActive
              ? 'bg-surface-2 text-text-primary'
              : 'text-text-muted hover:bg-surface-2 hover:text-text-primary',
          )
        }
      >
        {({ isActive }) => (
          <>
            {isActive && (
              <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent" />
            )}
            <Icon size={16} className={clsx('shrink-0', isActive && 'text-accent')} />
            {!collapsed && <span className="flex-1 truncate">{t(item.labelKey)}</span>}
            {badge > 0 && !collapsed && (
              <span
                className={clsx(
                  'inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold',
                  'bg-accent-soft text-accent',
                )}
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
            {badge > 0 && collapsed && (
              <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-canvas">
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </>
        )}
      </NavLink>
    </li>
  );
}



