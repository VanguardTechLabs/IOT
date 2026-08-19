import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Activity, Cpu, LogOut, Radio, Settings, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { getSocket } from '../lib/socket';

const NAV = [
  { to: '/devices', label: 'Devices', icon: Cpu },
  { to: '/account', label: 'Account', icon: Settings },
];

const ADMIN_NAV = { to: '/admin', label: 'Admin', icon: ShieldCheck };

export function Shell() {
  const { user, plan, logout } = useAuth();
  const navigate = useNavigate();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    setConnected(socket.connected);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-indigo-500 text-ink-950">
              <Activity size={17} strokeWidth={2.6} />
            </div>
            <div className="leading-tight">
              <p className="text-sm font-semibold tracking-tight text-white">Pulse</p>
              <p className="text-[10px] uppercase tracking-widest text-slate-500">IoT Platform</p>
            </div>
          </div>

          <nav className="flex items-center gap-1">
            {[...NAV, ...(user?.role === 'admin' ? [ADMIN_NAV] : [])].map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition',
                    isActive ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                  )
                }
              >
                <Icon size={16} />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span
              className={clsx(
                'chip',
                connected
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                  : 'border border-white/10 bg-white/5 text-slate-400',
              )}
              title={connected ? 'Live stream connected' : 'Reconnecting…'}
            >
              <Radio size={12} />
              <span className="hidden sm:inline">{connected ? 'Live' : 'Offline'}</span>
            </span>

            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-slate-200">{user?.name}</p>
              <p className="text-xs text-slate-500">{plan?.name} plan</p>
            </div>

            <button
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-white/5 hover:text-white"
              title="Sign out"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        <Outlet />
      </main>

      <footer className="border-t border-white/5 py-5 text-center text-xs text-slate-600">
        Pulse IoT · MQTT · HTTP · WebSockets
      </footer>
    </div>
  );
}
