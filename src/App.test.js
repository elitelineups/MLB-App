import { render, screen } from '@testing-library/react';
import App from './App';

test('renders MLB betting model heading', () => {
  global.fetch = jest.fn(() => new Promise(() => {}));
  render(<App />);
  expect(screen.getByText(/Projection Summary/i)).toBeInTheDocument();
});
