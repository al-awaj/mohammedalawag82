'use client';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import BlurTextJs from '@/components/react-bits/BlurText';
import CountUpJs from '@/components/react-bits/CountUp';
import LightRaysJs from '@/components/react-bits/LightRays';
import StarBorderJs from '@/components/react-bits/StarBorder';
import { prefersReducedMotion } from './motion';

// The vendored React Bits files are untyped JavaScript; their props are documented on the React Bits site.
type Loose = ComponentType<Record<string, unknown> & { children?: ReactNode }>;
const BlurText = BlurTextJs as unknown as Loose;
const CountUp = CountUpJs as unknown as Loose;
const LightRays = LightRaysJs as unknown as Loose;
const StarBorder = StarBorderJs as unknown as Loose;

/** The visitor's motion preference, known only after mount (the server renders the calm version). */
function useCalm() {
  const [calm, setCalm] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setCalm(mq.matches);
    const on = () => setCalm(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return calm;
}

/**
 * The home page title, words blurring in one after another. The text and the gradient word are the same as before;
 * `gradient` lists the word positions that keep the gradient and `breakAfter` where the line breaks.
 */
export function HeroTitle({ text, gradient, breakAfter }: { text: string; gradient: number[]; breakAfter: number[] }) {
  return (
    <BlurText as="h1" className="hero-title" text={text} animateBy="words" direction="top" delay={110} stepDuration={0.45}
      blur={8} distance={18} trigger="load" breakAfter={breakAfter} wordClassName={(w: number) => (gradient.includes(w) ? 'grad-text' : undefined)} />
  );
}

/** Soft rays behind the hero in the site's violet; not drawn at all for reduced motion. */
export function HeroRays() {
  const calm = useCalm();
  if (calm) return null;
  return (
    <div className="hero-rays" aria-hidden="true">
      <LightRays raysOrigin="top-center" raysColor="#e9d5ff" raysSpeed={0.55} lightSpread={0.7} rayLength={2.4} glow={0.35}
        haze={0.2} intensity={0.75} fadeDistance={0.9} followMouse mouseInfluence={0.04} cursorShadow={false} clickPulse={false} opacity={0.6} />
    </div>
  );
}

/** A number that counts up once when it scrolls into view; shown as is for reduced motion. */
export function CountNumber({ value }: { value: number }) {
  const calm = useCalm();
  if (calm) return <>{value}</>;
  return <CountUp from={0} to={value} duration={1.4} trigger="view" />;
}

/** The main call to action with a slow light travelling round its border. */
export function StarButton({ children, type = 'submit', className = '' }: { children: ReactNode; type?: 'submit' | 'button'; className?: string }) {
  const calm = useCalm();
  if (calm || prefersReducedMotion()) return <button className={`btn btn-primary btn-lg ${className}`} type={type}>{children}</button>;
  return (
    <StarBorder as="button" type={type} className={`btn btn-primary btn-lg star-btn ${className}`} radius={14} thickness={1}
      color="#fcd34d" duration={6} glow={0.45} hover="brighten" clickPulse={false} theme="dark"
      backgroundColor="var(--gradient)" textColor="#fff" borderColor="rgba(255, 255, 255, 0.22)">
      {children}
    </StarBorder>
  );
}
