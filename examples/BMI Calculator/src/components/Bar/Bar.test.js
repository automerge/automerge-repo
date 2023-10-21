import React from "react";
import { mount } from "enzyme";
import Bar from "./Bar";

jest.mock("react-chartjs-2", () => ({
  Line: () => null
}));

describe("Bar component", () => {
  let wrapper;
  const prop = {
    labelData: ["27/10/2019"],
    bmiData: ["16.14"]
  };

  beforeEach(() => {
    wrapper = mount(<Bar {...prop} />);
  });

  it("renders", () => {
    expect(wrapper).not.toBeNull();

    console.log(wrapper.debug());
  });
});
