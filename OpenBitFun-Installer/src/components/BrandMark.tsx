import { OpenBitFunMark } from '@openbitfun/ui/brand';

interface BrandMarkProps {
  size?: 'medium' | 'hero';
  working?: boolean;
}

/** The canonical fine-line vector is painted with the active surface's text color. */
export function BrandMark({ size = 'medium', working = false }: BrandMarkProps) {
  return <OpenBitFunMark className="brand-mark" data-size={size} motion="breathe" active={working} />;
}
