/** Corda's mark: a small filled circle with a four-point star. Anything Corda prepared or did carries it. */
export function CordaMark({ size = 18, title }: { size?: number; title?: string }) {
  return (
    <span className="corda-mark" style={{ width: size, height: size }} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <svg width={Math.round(size * 0.5)} height={Math.round(size * 0.5)} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" />
      </svg>
    </span>
  );
}
