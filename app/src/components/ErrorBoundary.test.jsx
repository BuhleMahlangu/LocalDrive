import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ErrorBoundary from './ErrorBoundary.jsx';

function Bomb({ shouldThrow }) {
  if (!shouldThrow) return <div>safe screen</div>;
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('renders children normally when there is no error', () => {
    render(<ErrorBoundary><div>hello</div></ErrorBoundary>);
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('shows a fallback when a child throws, then recovers via the button', async () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="k"><Bomb shouldThrow /></ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong on this screen/)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();

    // Fix the child and reset: the boundary re-renders its children.
    rerender(
      <ErrorBoundary resetKey="k"><Bomb shouldThrow={false} /></ErrorBoundary>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reload this screen/ }));
    expect(screen.getByText('safe screen')).toBeInTheDocument();
    expect(screen.queryByText(/Something went wrong/)).not.toBeInTheDocument();
  });

  it('clears the error when the resetKey changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="a"><Bomb shouldThrow /></ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="b"><Bomb shouldThrow={false} /></ErrorBoundary>,
    );
    expect(screen.getByText('safe screen')).toBeInTheDocument();
  });
});