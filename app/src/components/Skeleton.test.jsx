import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Skeleton from './Skeleton.jsx';

describe('Skeleton', () => {
  it('renders a shimmer block with the requested number of lines', () => {
    const { container } = render(<Skeleton lines={3} />);
    const stack = container.querySelector('.skeleton-stack');
    expect(stack).toBeInTheDocument();
    expect(stack.querySelectorAll('.line-md').length).toBe(1);
    expect(stack.querySelectorAll('.line-lg').length).toBe(2); // all but last
    expect(stack.querySelectorAll('.line-sm').length).toBe(1); // the last line
  });

  it('adds the card class when card is set', () => {
    const { container } = render(<Skeleton card />);
    expect(container.querySelector('.skeleton-card-space')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-bar-space')).toBeNull();
  });

  it('adds an avatar slot when avatar is set', () => {
    const { container } = render(<Skeleton avatar lines={1} />);
    expect(container.querySelector('.skeleton.avatar')).toBeInTheDocument();
    expect(container.querySelector('.skeleton-line-row')).toBeInTheDocument();
  });

  it('passes through className and style', () => {
    const { container } = render(<Skeleton className="extra" style={{ marginTop: '4px' }} />);
    const el = container.firstChild;
    expect(el).toHaveClass('extra');
    expect(el).toHaveStyle({ marginTop: '4px' });
  });
});