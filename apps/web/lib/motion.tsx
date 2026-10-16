'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

gsap.registerPlugin(ScrollTrigger);

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What each section does when it scrolls into view: a short fade and lift, nothing more. */
const REVEAL = { autoAlpha: 1, y: 0, duration: 0.8, ease: 'power2.out' } as const;
const SELECTOR = '.site-main .section, .site-main .cta, .site-main [data-reveal]';

/**
 * Smooth scrolling and scroll-driven reveals for the website. Lenis runs on GSAP's ticker so the scroll position and
 * every ScrollTrigger animation advance in the same frame. Nothing here runs when the visitor asks for reduced motion.
 */
export function MotionLayer() {
  const path = usePathname();

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    // Touch devices keep their native scrolling; nested scroll areas (dialogs, tables) scroll on their own.
    const lenis = new Lenis({ duration: 1.05, smoothWheel: true, allowNestedScroll: true });
    lenis.on('scroll', ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);
    (window as unknown as { __lenis?: Lenis }).__lenis = lenis;
    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
      delete (window as unknown as { __lenis?: Lenis }).__lenis;
    };
  }, []);

  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    (window as unknown as { __lenis?: Lenis }).__lenis?.scrollTo(0, { immediate: true });
    const ctx = gsap.context(() => {
      const fold = window.innerHeight * 0.92;
      for (const el of gsap.utils.toArray<HTMLElement>(SELECTOR)) {
        // What is already on screen stays as rendered; only what is below the fold waits for the scroll.
        if (el.getBoundingClientRect().top < fold) continue;
        gsap.set(el, { autoAlpha: 0, y: 28 });
        ScrollTrigger.create({ trigger: el, start: 'top 88%', once: true, onEnter: () => gsap.to(el, REVEAL) });
      }
    });
    ScrollTrigger.refresh();
    return () => ctx.revert();
  }, [path]);

  return null;
}
