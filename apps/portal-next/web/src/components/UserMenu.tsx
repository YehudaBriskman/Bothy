// The person control in the topbar's right cluster.
//
// STUB - the contract, not the implementation. It renders enough to be wired and
// typechecked; the real menu is filled in separately. Keep the exported shape.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserRound } from 'lucide-react';
import { fetchMe, type Me } from '../lib/me';

export function useMe(): { me: Me | null; loading: boolean } {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ac = new AbortController();
    fetchMe(ac.signal)
      .then((m) => { if (!ac.signal.aborted) { setMe(m); setLoading(false); } })
      .catch(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, []);
  return { me, loading };
}

export function UserMenu() {
  const { me } = useMe();
  return (
    <Link className="hbtn user-btn" to="/settings" title={me ? me.preferredUsername : 'Sign in'}
      aria-label={me ? `Settings - signed in as ${me.preferredUsername}` : 'Sign in'}>
      <UserRound size={16} />
    </Link>
  );
}
