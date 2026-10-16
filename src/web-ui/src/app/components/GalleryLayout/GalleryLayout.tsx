import React from 'react';
import { ScrollArea } from '@openbitfun/ui';
import './GalleryLayout.scss';

interface GalleryLayoutProps extends React.HTMLAttributes<HTMLDivElement> {
  header?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const GalleryLayout: React.FC<GalleryLayoutProps> = ({ header, children, className, ...rootProps }) => (
  <div
    data-openbitfun-component="gallery-layout"
    data-openbitfun-part="root"
    {...rootProps}
    className={['gallery-layout', className].filter(Boolean).join(' ')}
  >
    {header}
    <ScrollArea className="gallery-layout__body" data-openbitfun-component="gallery-layout" data-openbitfun-part="body">
      <div className="gallery-layout__body-inner" data-openbitfun-component="gallery-layout" data-openbitfun-part="content">
        {children}
      </div>
    </ScrollArea>
  </div>
);

export default GalleryLayout;
export type { GalleryLayoutProps };
