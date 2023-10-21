import React from 'react';
import { shallow } from 'enzyme';
import App from './App';

describe('App Component', () => {
  let wrapper;
  beforeEach(() => {
    wrapper = shallow(<App />);
  });

  it('renders', () => {
    expect(wrapper).not.toBeNull();
  });
});
