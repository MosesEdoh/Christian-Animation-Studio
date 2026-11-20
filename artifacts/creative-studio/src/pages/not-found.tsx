import { Link } from 'wouter';
import { Compass } from 'lucide-react';
import { BrandScreen } from '@/components/PublicPages';

export default function NotFound() {
  return (
    <BrandScreen step="Page not found" testId="page-not-found">
      <span className="brand-screen-icon" aria-hidden="true"><Compass size={20} /></span>
      <h1 className="brand-screen-title">This scene isn’t in the script</h1>
      <p className="brand-screen-copy">The page you were looking for doesn’t exist or may have moved.</p>
      <div className="brand-screen-actions">
        <Link className="btn btn-primary" href="/">Go to home</Link>
        <Link className="btn btn-quiet" href="/studio">Open the studio</Link>
      </div>
    </BrandScreen>
  );
}
