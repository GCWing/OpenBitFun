import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Icon, IconButton, Portal, ScrollArea } from '@openbitfun/ui';
import { useAnnouncementStore } from '../store/announcementStore';
import FeatureModalPage from './FeatureModalPage';
import { useAnnouncementI18n } from '../hooks/useAnnouncementI18n';
import '../styles/FeatureModal.scss';
import type { ModalConfig } from '../types';

const FEATURE_MODAL_EXIT_MS = 180;
const FEATURE_MODAL_PAGE_MS = 180;

interface FeatureModalPagesProps {
  pages: NonNullable<ModalConfig['pages']>;
  currentPage: number;
}

const FeatureModalPages: React.FC<FeatureModalPagesProps> = ({ pages, currentPage }) => {
  const [displayedPage, setDisplayedPage] = useState(currentPage);
  const [leavingPage, setLeavingPage] = useState<number | null>(null);
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const settleTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (currentPage === displayedPage) return;
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    setDirection(currentPage > displayedPage ? 'forward' : 'backward');
    setLeavingPage(displayedPage);
    setDisplayedPage(currentPage);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      setLeavingPage(null);
    }, FEATURE_MODAL_PAGE_MS);
  }, [currentPage, displayedPage]);

  useEffect(() => () => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
  }, []);

  const renderPage = (pageIndex: number, state: 'active' | 'leaving') => {
    const page = pages[pageIndex];
    if (!page) return null;
    return (
      <ScrollArea
        key={`${state}-${pageIndex}`}
        className="feature-modal__page"
        data-state={state}
        data-direction={direction}
        aria-hidden={state !== 'active'}
        {...(state !== 'active' ? { inert: '' } : {})}
      >
        <FeatureModalPage page={page} active={state === 'active'} />
      </ScrollArea>
    );
  };

  return (
    <>
      {leavingPage !== null && leavingPage !== displayedPage
        ? renderPage(leavingPage, 'leaving')
        : null}
      {renderPage(displayedPage, 'active')}
    </>
  );
};

/**
 * Centre-screen feature demo modal.
 *
 * - Multi-page with dot-indicator navigation.
 * - Each page can carry a media asset (Lottie, video, image, GIF).
 * - Backdrop click closes the modal when `closable` is true.
 * - Supports a "Don't show again" completion action.
 */
const FeatureModal: React.FC = () => {
  const { t } = useAnnouncementI18n();
  const {
    openModal,
    modalVisible,
    currentPage,
    setPage,
    closeModal,
    markModalPresented,
  } = useAnnouncementStore();

  const [exiting, setExiting] = React.useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  // When modalVisible becomes false trigger the exit animation.
  useEffect(() => {
    if (!modalVisible) setExiting(false);
  }, [modalVisible]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (
      openModal
      && modalVisible
      && openModal.modal?.presentation !== 'release_letter'
      && backdropRef.current
    ) {
      markModalPresented(openModal);
    }
  }, [markModalPresented, modalVisible, openModal]);

  if (
    !openModal
    || !modalVisible
    || openModal.modal?.presentation === 'release_letter'
  ) return null;

  const modal: ModalConfig = openModal.modal!;
  const pages = modal.pages ?? [];
  const isFirst = currentPage === 0;
  const isLast = currentPage === pages.length - 1;

  function triggerClose(neverShow = false) {
    if (exiting) return;
    setExiting(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      closeModal(neverShow);
    }, FEATURE_MODAL_EXIT_MS);
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === backdropRef.current && modal.closable) {
      triggerClose();
    }
  }

  const sizeClass = `feature-modal--${modal.size ?? 'lg'}`;

  return (
    <Portal modal open={!exiting} surfaceRef={backdropRef}
      onDismiss={() => triggerClose()} dismissOnEscape={Boolean(modal.closable)}>
    <div
      ref={backdropRef}
      className={`feature-modal-backdrop${exiting ? ' feature-modal-backdrop--exiting' : ''}`}
      data-openbitfun-component="announcement"
      data-openbitfun-part="modalBackdrop"
      onClick={handleBackdropClick}
      role="dialog"
      tabIndex={-1}
      data-openbitfun-native-webview-occlusion
      aria-modal="true"
      aria-hidden={exiting}
      {...(exiting ? { inert: '' } : {})}
    >
      <div className={`feature-modal ${sizeClass}${exiting ? ' feature-modal--exiting' : ''}`} data-openbitfun-component="announcement" data-openbitfun-part="modal">
        {/* Close button */}
        {modal.closable && (
          <IconButton
            className="feature-modal__close"
            icon={<Icon name="xmark" size="lg" />}
            size="md"
            data-openbitfun-component="announcement"
            data-openbitfun-part="modalClose"
            onClick={() => triggerClose()}
            aria-label={t('announcements.common.close')}
          />
        )}

        {/* Page viewport */}
        <div className="feature-modal__pages" data-openbitfun-component="announcement" data-openbitfun-part="modalPages">
          <FeatureModalPages pages={pages} currentPage={currentPage} />
        </div>

        {/* Footer navigation */}
        <div className="feature-modal__footer" data-openbitfun-component="announcement" data-openbitfun-part="modalFooter">
          {/* Dot indicators */}
          <div className="feature-modal__dots" aria-label="Page navigation">
            {pages.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`feature-modal__dot${i === currentPage ? ' feature-modal__dot--active' : ''}`}
                onClick={() => setPage(i)}
                aria-label={`${t('announcements.common.page')} ${i + 1}`}
              />
            ))}
          </div>

          {/* Navigation buttons */}
          <div className="feature-modal__nav" data-openbitfun-component="announcement" data-openbitfun-part="modalNavigation">
            {modal.completion_action === 'never_show_again' && isLast && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => triggerClose(true)}
              >
                {t('announcements.common.never_show_again')}
              </Button>
            )}
            {!isFirst && (
              <Button
                variant="fill"
                size="sm"
                onClick={() => setPage(currentPage - 1)}
              >
                {t('announcements.common.prev')}
              </Button>
            )}
            {!isLast ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setPage(currentPage + 1)}
              >
                {t('announcements.common.next')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => triggerClose()}
              >
                {t('announcements.common.done')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
    </Portal>
  );
};

export default FeatureModal;
