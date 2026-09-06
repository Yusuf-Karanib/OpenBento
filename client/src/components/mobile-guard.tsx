import { useState, useEffect } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';

const MOBILE_BREAKPOINT = 1024;

export function MobileGuard({ children }: { children: React.ReactNode }) {
  const [isMobile, setIsMobile] = useState(false);
  const [continueAnyway, setContinueAnyway] = useState(false);
  const [location] = useLocation();

  useEffect(() => {
    const checkWidth = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    
    checkWidth();
    window.addEventListener('resize', checkWidth);
    return () => window.removeEventListener('resize', checkWidth);
  }, []);

  // Legal, account-recovery, feedback, marketplace, and Cast pages must stay
  // reachable on small screens. Only warn on the desktop-focused workspaces.
  const isDesktopWorkspace = location === '/' || location === '/admin';
  if (!isMobile || !isDesktopWorkspace || continueAnyway) {
    return <>{children}</>;
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-8">
        <div className="flex justify-center">
          <div className="relative">
            <Monitor className="w-24 h-24 text-cyan-400" />
            <Smartphone className="w-10 h-10 text-slate-500 absolute -bottom-2 -right-2" />
            <div className="absolute inset-0 bg-cyan-400/20 blur-3xl rounded-full" />
          </div>
        </div>

        <div className="space-y-4">
          <h1 className="text-3xl font-bold text-white" data-testid="text-mobile-guard-title">
            Desktop Experience Only
          </h1>
          <p className="text-lg text-slate-300 leading-relaxed" data-testid="text-mobile-guard-message">
            The web dashboard is designed for a desktop-sized screen. You can still open it here, but some controls may feel cramped.
          </p>
        </div>

        <Button
          type="button"
          size="lg"
          onClick={() => setContinueAnyway(true)}
          className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-semibold"
          data-testid="button-mobile-continue"
        >
          Continue Anyway
        </Button>

        <p className="text-sm text-slate-500">
          For the easiest experience, use a desktop or laptop computer.
        </p>
      </div>
    </div>
  );
}
