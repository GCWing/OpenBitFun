/**
 * The upstream Open Intelligent UI library, vendored from
 * task_genui/open-intelligent-ui/src/lib/library.ts.
 *
 * This is intentionally a native @openuidev/react-lang library. It does not
 * pass through OpenBitFun's oiComponents adapter: the selected `openui` profile
 * must render the same registered components and CSS as the upstream app.
 */
import { createLibrary } from '@openuidev/react-lang';
import { actions } from './openui/actions';
import { functions } from './openui/functions';
import './openui/theme.css';
import './openui/components.css';
import './openui/map/map.css';
import { Chart } from './openui/chart';
import { Carousel, Celebration, Code, Flashcard, MathBlock, Popover, Quote, YouTube } from './openui/extra';
import {
  Button,
  Checkbox,
  DatePicker,
  IconButton,
  Input,
  Pressable,
  RadioGroup,
  SegmentedControl,
  Select,
  Slider,
  TextArea,
  Timer,
} from './openui/controls';
import { HtmlView } from './openui/html-view';
import { Box, Card, Col, Divider, Form, Grid, Row, Spacer } from './openui/layout';
import { MapMarker, MapView } from './openui/map/map';
import { Icon, Image, SearchImage } from './openui/media';
import { svgComponents } from './openui/svgComponents';
import { Table } from './openui/table';
import { Badge, Caption, Label, Link, List, ListItem, Markdown, Text, Title } from './openui/text';

export const openUIBaseComponents = [
  Col, Row, Box, Grid, Card, Carousel, Popover, Divider, Spacer,
  Title, Text, Caption, Label, Badge, Link, List, ListItem, Markdown, Quote, Code, MathBlock,
  Button, IconButton, Pressable, Input, TextArea, Select, SegmentedControl, Slider, Checkbox, RadioGroup, DatePicker, Timer, Form,
  SearchImage, Image, Icon, Table, Chart, MapView, MapMarker, YouTube,
  Flashcard, Celebration,
  ...svgComponents, HtmlView,
];

export const openUILibrary = createLibrary({
  id: 'openui.v1',
  root: 'Col',
  components: openUIBaseComponents,
  functions,
  actions,
});
