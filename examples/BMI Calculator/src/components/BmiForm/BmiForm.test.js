import React from "react";
import { shallow } from "enzyme";
import BmiForm from "./BmiForm";

describe("BmiForm Component", () => {
  let wrapper;
  const prop = {
    change: jest.fn()
  };

  beforeEach(() => {
    wrapper = shallow(<BmiForm {...prop} />);
  });

  it("renders", () => {
    expect(wrapper).not.toBeNull();
  });

  it("should update the weight", () => {
    const weight = wrapper.find("#weight");
    weight.simulate("change", { target: { name: "weight", value: "50" } });
    expect(wrapper.find("#weight").props().value).toEqual("50");
  });

  it("should update the height", () => {
    const height = wrapper.find("#height");
    height.simulate("change", { target: { name: "height", value: "176" } });
    expect(wrapper.find("#height").props().value).toEqual("176");
  });

  it("should call change", () => {
    wrapper.find("button").simulate("click");
    expect(prop.change).toHaveBeenCalledTimes(1);
  });
});
