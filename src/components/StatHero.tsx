import { HEADER_STAT_SURFACE } from "../lib/surfaceStyles";

interface StatHeroProps {
  label: string;
  value: string;
}

export function StatHero({ label, value }: StatHeroProps) {
  return (
    <div className={HEADER_STAT_SURFACE}>
      <p className="text-[10px] uppercase tracking-[0.3em] text-secondary/60">{label}</p>
      <p className="mt-1 text-3xl text-primary font-light">{value}</p>
    </div>
  );
}
