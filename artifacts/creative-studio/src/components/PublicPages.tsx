import type { ReactNode } from 'react';
import { Link } from 'wouter';
import {
  ArrowRight,
  BookOpen,
  Camera,
  Clapperboard,
  Download,
  Film,
  HeartHandshake,
  LoaderCircle,
  LockKeyhole,
  MessageCircleQuestion,
  PenLine,
  ShieldCheck,
  Sparkles,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

export function BrandMark({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  return (
    <span className={`public-brand ${tone === 'light' ? 'is-light' : ''}`}>
      <span className="brand-mark" aria-hidden="true">F&amp;F</span>
      <span>
        <span className="public-brand-name">Frame &amp; Faith</span>
        <span className="public-brand-kicker">Christian animation studio</span>
      </span>
    </span>
  );
}

/** Centered, branded card used for loading, access and recovery screens. */
export function BrandScreen({
  children,
  step,
  testId,
}: {
  children: ReactNode;
  step?: string;
  testId?: string;
}) {
  return (
    <main className="brand-screen" data-testid={testId}>
      <div className="brand-screen-card">
        <div className="brand-screen-top">
          <BrandMark />
          {step ? <span className="brand-screen-step">{step}</span> : null}
        </div>
        <div className="brand-screen-body">{children}</div>
      </div>
      <p className="brand-screen-foot">Bible-grounded stories for ages 5–17 · Private by default</p>
    </main>
  );
}

export function LoadingScreen({ message }: { message: string }) {
  return (
    <BrandScreen testId="state-loading-screen">
      <div className="loading-inline" role="status" aria-live="polite">
        <LoaderCircle size={18} className="loading-mark" aria-hidden="true" />
        <span>{message}</span>
      </div>
    </BrandScreen>
  );
}

/** Two-column frame around Clerk's sign-in and sign-up cards. */
export function AuthShell({ children, mode }: { children: ReactNode; mode: 'sign-in' | 'sign-up' }) {
  return (
    <main className="auth-shell">
      <aside className="auth-story" aria-label="About Frame & Faith">
        <Link href="/" className="auth-home-link"><BrandMark tone="light" /></Link>
        <div>
          <p className="auth-eyebrow">{mode === 'sign-in' ? 'Welcome back to the room' : 'Join the studio'}</p>
          <h1 className="auth-title">Every honest question deserves a story.</h1>
          <ul className="auth-points">
            <li><PenLine size={15} aria-hidden="true" /> Write scripts with an AI co-writer and audience check</li>
            <li><Camera size={15} aria-hidden="true" /> Storyboard shots and direct each emotional beat</li>
            <li><Film size={15} aria-hidden="true" /> Animate clips and export full episodes</li>
          </ul>
        </div>
        <p className="auth-security"><LockKeyhole size={14} aria-hidden="true" /> Verified email plus a trusted browser keeps studio work private.</p>
      </aside>
      <section className="auth-form-side">
        {children}
        <Link href="/" className="auth-back">← Back to home</Link>
      </section>
    </main>
  );
}

const departments: Array<{ icon: LucideIcon; title: string; body: string }> = [
  { icon: PenLine, title: 'Script Studio', body: 'Draft scenes with an AI co-writer, run an age-aware audience check, and complete a full six-scene episode in one pass.' },
  { icon: Clapperboard, title: 'Directing', body: 'Name the emotional beat and get director notes that keep every moment honest and on story.' },
  { icon: Camera, title: 'Cinematography', body: 'Get shot suggestions, upload reference boards, and arrange storyboard cards by drag and drop.' },
  { icon: Film, title: 'Animation', body: 'Turn storyboard cards into video clips in landscape or portrait, then preview and download them.' },
  { icon: MessageCircleQuestion, title: 'Faith questions', body: 'Explore the hard questions children carry with Bible-grounded responses, and turn them into scenes.' },
  { icon: Download, title: 'Export & share', body: 'Download scripts, storyboard movies, episode MP4s, or the whole series as one package.' },
];

const steps = [
  { title: 'Create your account', body: 'Sign up with a verified email address.' },
  { title: 'Trust this browser', body: 'Add your device once to unlock private scripts and media.' },
  { title: 'Write and storyboard', body: 'Shape characters, scenes, and shots for each episode.' },
  { title: 'Animate and export', body: 'Generate clips and download finished episodes.' },
];

const commitments: Array<{ icon: LucideIcon; title: string; body: string }> = [
  { icon: BookOpen, title: 'Rooted in the Bible', body: 'Stories and answers point back to Scripture, with references you can check.' },
  { icon: Sparkles, title: 'Age-aware by design', body: 'Tune writing for ages 5–8, 9–12, or 13–17, and check each scene for its audience.' },
  { icon: LockKeyhole, title: 'Private by default', body: 'References and videos live in private storage, viewable only on trusted devices.' },
  { icon: HeartHandshake, title: 'Safe adults, not secrets', body: 'Guidance always points children toward a trusted, safe adult. Guardian controls are built in.' },
];

export function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-container landing-nav-inner">
          <Link href="/" aria-label="Frame & Faith home"><BrandMark /></Link>
          <nav className="landing-nav-actions" aria-label="Account">
            <Link className="btn btn-quiet" href="/sign-in" data-testid="login-btn">Sign in</Link>
            <Link className="btn btn-primary" href="/sign-up" data-testid="link-create-account">Create account</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-container landing-hero-grid">
            <div className="landing-hero-copy">
              <p className="eyebrow">Christian animation studio</p>
              <h1 className="landing-title">Bible-grounded stories, from first page to <span className="display-script">final frame.</span></h1>
              <p className="landing-lead">
                Frame &amp; Faith is a private studio for writing, directing, and animating Christian action series for ages 5–17. It’s built for creators, parents, editors, and animators.
              </p>
              <div className="landing-cta">
                <Link className="btn btn-primary btn-lg" href="/sign-up">Start creating <ArrowRight size={15} aria-hidden="true" /></Link>
                <Link className="btn btn-quiet btn-lg" href="/sign-in">I already have an account</Link>
              </div>
              <ul className="landing-trust" aria-label="Highlights">
                <li><ShieldCheck size={14} aria-hidden="true" /> Trusted-device privacy</li>
                <li><UsersRound size={14} aria-hidden="true" /> Guardian controls</li>
                <li><BookOpen size={14} aria-hidden="true" /> Scripture references</li>
              </ul>
            </div>
            <HeroBoard />
          </div>
        </section>

        <section className="landing-section" aria-labelledby="departments-title">
          <div className="landing-container">
            <div className="landing-section-head">
              <p className="eyebrow">One room, every department</p>
              <h2 id="departments-title">Everything a small team needs to make a series.</h2>
              <p>Move from idea to episode without juggling tools. Each department picks up where the last one left off.</p>
            </div>
            <div className="feature-grid">
              {departments.map(({ icon: Icon, title, body }) => (
                <article className="feature-card" key={title}>
                  <span className="feature-icon" aria-hidden="true"><Icon size={18} /></span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-section landing-steps-section" aria-labelledby="steps-title">
          <div className="landing-container">
            <div className="landing-section-head">
              <p className="eyebrow">How it works</p>
              <h2 id="steps-title">Up and running in four steps.</h2>
            </div>
            <ol className="steps-grid">
              {steps.map((step, index) => (
                <li className="step-card" key={step.title}>
                  <span className="step-number">{String(index + 1).padStart(2, '0')}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="landing-section" aria-labelledby="care-title">
          <div className="landing-container">
            <div className="landing-section-head">
              <p className="eyebrow">Made with care</p>
              <h2 id="care-title">Built for children’s stories, and the adults who tell them.</h2>
            </div>
            <div className="care-grid">
              {commitments.map(({ icon: Icon, title, body }) => (
                <article className="care-card" key={title}>
                  <Icon size={18} aria-hidden="true" />
                  <div><h3>{title}</h3><p>{body}</p></div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-final" aria-labelledby="final-title">
          <div className="landing-container">
            <div className="landing-final-inner">
              <div>
                <h2 id="final-title">Keep the light in the frame.</h2>
                <p>One small, honest scene at a time is still a whole season in motion.</p>
              </div>
              <div className="landing-cta">
                <Link className="btn btn-sun btn-lg" href="/sign-up">Create your account <ArrowRight size={15} aria-hidden="true" /></Link>
                <Link className="btn btn-ghost-light btn-lg" href="/sign-in">Sign in</Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-container landing-footer-inner">
          <BrandMark />
          <p>For story development. If a child may be unsafe, involve a trusted safe adult.</p>
        </div>
      </footer>
    </div>
  );
}

/** Decorative production board: a script page, a storyboard card, and a clip, built from CSS. */
function HeroBoard() {
  return (
    <div className="hero-board" aria-hidden="true">
      <div className="hero-sheet hero-script">
        <span className="hero-label">Scene 03 · INT. SCHOOL HALLWAY — DAY</span>
        <p className="hero-line"><strong>MARA</strong></p>
        <p className="hero-line">What if I’m not brave enough?</p>
        <p className="hero-line"><strong>JONAH</strong></p>
        <p className="hero-line">“Be strong and courageous.” You don’t have to do it alone.</p>
        <span className="hero-chip"><ShieldCheck size={12} /> Audience check · ages 9–12</span>
      </div>
      <div className="hero-sheet hero-shot">
        <div className="hero-frame"><span className="hero-sun" /><span className="hero-figure" /><span className="hero-figure small" /></div>
        <div className="hero-tags"><span>Wide</span><span>Slow push-in</span><span>Eye level</span></div>
      </div>
      <div className="hero-sheet hero-clip">
        <span className="hero-play"><Film size={14} /></span>
        <div><strong>Clip ready</strong><span>16:9 · 8 seconds</span></div>
      </div>
    </div>
  );
}
