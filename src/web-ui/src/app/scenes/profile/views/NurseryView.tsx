import React from 'react';
import { useNurseryStore } from '../nurseryStore';
import NurseryGallery from './NurseryGallery';
import AssistantConfigPage from './AssistantConfigPage';

const NurseryView: React.FC = () => {
  const { page } = useNurseryStore();

  if (page === 'assistant') {
    return <AssistantConfigPage />;
  }

  return <NurseryGallery />;
};

export default NurseryView;
